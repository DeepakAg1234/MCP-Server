import type { InvocationContext } from "../domain/context.js";
import { failure, withReplayWarning, type Envelope, type FailureEnvelope, type SuccessEnvelope } from "../domain/envelope.js";
import type { OperationRecord, TokenStore } from "../auth/token-store.js";
import type { Metrics } from "../observability/metrics.js";
import { noopMetrics } from "../observability/metrics.js";

export type IdempotencyDecision =
  | { type: "omit_key" }
  | { type: "execute" }
  | { type: "replay"; envelope: SuccessEnvelope<Record<string, unknown>> }
  | { type: "stop"; envelope: FailureEnvelope };

export class IdempotencyService {
  constructor(
    private readonly store: TokenStore,
    private readonly leaseSeconds: number,
    private readonly clock: () => Date,
    private readonly metrics: Metrics = noopMetrics,
  ) {}

  async begin(ctx: InvocationContext, tool: string, key: string | undefined, hash: string): Promise<IdempotencyDecision> {
    if (!key) return { type: "omit_key" };
    let decision: IdempotencyDecision;
    try {
      decision = await this.reserve(ctx, tool, key, hash);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      decision = await this.reserve(ctx, tool, key, hash);
    }
    this.metrics.increment("idempotency_total", { tool, result: idempotencyResult(decision) });
    return decision;
  }

  private async reserve(ctx: InvocationContext, tool: string, key: string, hash: string): Promise<IdempotencyDecision> {
    const decision: IdempotencyDecision = await this.store.transaction(async () => {
      const now = this.clock();
      const row = await this.store.getOperation(ctx.tenantId, ctx.userId, tool, key);
      if (!row) {
        await this.store.insertOperation({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          tool,
          idempotencyKey: key,
          requestHash: hash,
          status: "reserved",
          leaseUntil: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString(),
          operationId: ctx.operationId,
          envelopeJson: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        return { type: "execute" };
      }

      let current = row;
      if (current.status === "reserved" && current.leaseUntil && Date.parse(current.leaseUntil) <= now.getTime()) {
        current = await this.write(current, {
          status: "unknown",
          leaseUntil: null,
          updatedAt: now.toISOString(),
        });
      }

      if (current.requestHash !== hash && current.status !== "reserved") {
        return { type: "stop", envelope: this.hashConflict(tool, ctx.operationId) };
      }
      if (current.status === "completed" && current.requestHash === hash) {
        const stored = JSON.parse(current.envelopeJson ?? "null") as SuccessEnvelope<Record<string, unknown>> | null;
        if (!stored || stored.ok !== true) {
          return {
            type: "stop",
            envelope: failure({
              tool,
              operationId: ctx.operationId,
              code: "INTERNAL_ERROR",
              message: "The stored result for this idempotency key is unreadable.",
            }),
          };
        }
        return { type: "replay", envelope: withReplayWarning(stored) };
      }
      if (current.status === "failed" && current.requestHash === hash) {
        await this.write(current, {
          status: "reserved",
          requestHash: hash,
          leaseUntil: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString(),
          operationId: ctx.operationId,
          envelopeJson: null,
          updatedAt: now.toISOString(),
        });
        return { type: "execute" };
      }
      if (current.status === "unknown") {
        return { type: "stop", envelope: this.unknownConflict(tool, ctx.operationId) };
      }
      if (current.status === "reserved") {
        if (current.requestHash !== hash) {
          return { type: "stop", envelope: this.hashConflict(tool, ctx.operationId) };
        }
        const remainingMs = Math.max(0, Date.parse(current.leaseUntil ?? now.toISOString()) - now.getTime());
        return {
          type: "stop",
          envelope: failure({
            tool,
            operationId: ctx.operationId,
            code: "CONFLICT",
            message: "A request with this idempotency key is still in progress.",
            retryable: true,
            retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
            nextAction: "Wait for the in-progress request to finish, then retry the same request.",
          }),
        };
      }
      return { type: "stop", envelope: this.hashConflict(tool, ctx.operationId) };
    });
    return decision;
  }

  async complete(ctx: InvocationContext, tool: string, key: string | undefined, envelope: Envelope): Promise<void> {
    await this.finish(ctx, tool, key, "completed", envelope);
  }

  async fail(ctx: InvocationContext, tool: string, key: string | undefined, envelope: Envelope): Promise<void> {
    await this.finish(ctx, tool, key, "failed", envelope);
  }

  async markUnknown(ctx: InvocationContext, tool: string, key: string | undefined, envelope: Envelope): Promise<void> {
    await this.finish(ctx, tool, key, "unknown", envelope);
    if (key) this.metrics.increment("idempotency_total", { tool, result: "unknown" });
  }

  private async finish(
    ctx: InvocationContext,
    tool: string,
    key: string | undefined,
    status: "completed" | "failed" | "unknown",
    envelope: Envelope,
  ): Promise<void> {
    if (!key) return;
    const now = this.clock().toISOString();
    const row = await this.store.getOperation(ctx.tenantId, ctx.userId, tool, key);
    if (!row) return;
    await this.store.updateOperation({
      ...row,
      status,
      leaseUntil: null,
      envelopeJson: JSON.stringify(envelope),
      updatedAt: now,
    });
  }

  private async write(row: OperationRecord, patch: Partial<OperationRecord> & { updatedAt: string }): Promise<OperationRecord> {
    const next: OperationRecord = {
      ...row,
      ...patch,
    };
    await this.store.updateOperation({ ...next, updatedAt: patch.updatedAt });
    return next;
  }

  private hashConflict(tool: string, operationId: string): FailureEnvelope {
    return failure({
      tool,
      operationId,
      code: "IDEMPOTENCY_CONFLICT",
      message: "This idempotency key was already used with a different request.",
      nextAction: "Retry with a new idempotency key.",
    });
  }

  private unknownConflict(tool: string, operationId: string): FailureEnvelope {
    return failure({
      tool,
      operationId,
      code: "CONFLICT",
      message: "The previous attempt may have succeeded. This idempotency key will not call Google again.",
      retryable: false,
      nextAction: "Confirm the side effect out of band. Use a new idempotency key only if it did not happen.",
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (code === "23505") return true;
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : "");
}

function idempotencyResult(decision: IdempotencyDecision): "reserved" | "replay" | "conflict" | "unknown" {
  if (decision.type === "execute" || decision.type === "omit_key") return "reserved";
  if (decision.type === "replay") return "replay";
  if (decision.type === "stop" && decision.envelope.error.message.includes("may have succeeded")) return "unknown";
  return "conflict";
}
