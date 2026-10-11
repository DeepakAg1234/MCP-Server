import type { AppConfig } from "../config/env.js";
import type { AccessTokenCache } from "../auth/access-token-cache.js";
import type { AccountRecord, TokenStore } from "../auth/token-store.js";
import type { InvocationContext } from "../domain/context.js";
import { failure, success, WARNING, type Envelope, type FailureEnvelope } from "../domain/envelope.js";
import { GoogleApiError } from "../domain/errors.js";
import { requestHash } from "../domain/hash.js";
import { missingScopesFor, TOOL } from "../domain/tools.js";
import type { DocsClient } from "../google/docs-client.js";
import type { AuditWriter } from "../observability/audit.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { RateLimiter } from "../policy/rate-limiter.js";
import type { IdempotencyService } from "./idempotency-service.js";
import { parseDocsAppendInput } from "../tools/validate.js";

export type DocsAppendResult = {
  document_id: string;
  account_id: string;
  status: "appended";
  start_index: number;
  end_index: number;
  base_revision_id: string;
  revision_id?: string;
  document_title: string;
};

export class DocsService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: TokenStore,
    private readonly tokens: AccessTokenCache,
    private readonly docs: DocsClient,
    private readonly idempotency: IdempotencyService,
    private readonly policy: PolicyEngine,
    private readonly rateLimiter: RateLimiter,
    private readonly audit: AuditWriter,
    private readonly logger: Logger,
    private readonly clock: () => Date,
    private readonly metrics: Metrics,
  ) {}

  async append(ctx: InvocationContext, input: unknown): Promise<Envelope<DocsAppendResult>> {
    const started = Date.now();
    const parsed = parseDocsAppendInput(input, this.config);
    if (!parsed.ok) {
      return await this.fail(ctx, started, null, null, failure({
        tool: TOOL.appendContent,
        operationId: ctx.operationId,
        code: "INVALID_ARGUMENT",
        message: parsed.message,
      }));
    }
    const command = parsed.value;
    const account = await this.resolve(ctx, command.accountId);
    if (!account) {
      return await this.fail(ctx, started, command.accountId ?? null, command.canonicalDocumentId, failure({
        tool: TOOL.appendContent,
        operationId: ctx.operationId,
        code: "ACCOUNT_NOT_FOUND",
        message: "No Google account is available for this user.",
        nextAction: "Call google_list_accounts, or google_begin_authorization to connect one.",
      }));
    }
    if (account.status === "reauthorization_required" || !account.hasRefreshToken) {
      return await this.fail(ctx, started, account.accountId, command.canonicalDocumentId, failure({
        tool: TOOL.appendContent,
        operationId: ctx.operationId,
        code: "UNAUTHENTICATED",
        message: "The selected account must be authorized again.",
        nextAction: "Call google_begin_authorization with capability docs.append for this account.",
      }));
    }
    const missing = missingScopesFor("docs.append", account.grantedScopes);
    if (missing.length > 0) {
      return await this.fail(ctx, started, account.accountId, command.canonicalDocumentId, failure({
        tool: TOOL.appendContent,
        operationId: ctx.operationId,
        code: "INSUFFICIENT_SCOPE",
        message: "The selected account is not authorized to edit documents.",
        nextAction: "Call google_begin_authorization with capability docs.append for this account.",
      }));
    }

    const policy = this.policy.evaluate({
      tool: TOOL.appendContent,
      accountId: account.accountId,
      documentId: command.canonicalDocumentId,
    });
    if (!policy.allowed) {
      return await this.fail(ctx, started, account.accountId, command.canonicalDocumentId, failure({
        tool: TOOL.appendContent,
        operationId: ctx.operationId,
        code: "ACCESS_DENIED",
        message: policy.message,
      }));
    }
    const limitRequest = {
      tool: TOOL.appendContent,
      accountId: account.accountId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    };
    const limit = this.rateLimiter.take(limitRequest);
    if (!limit.allowed) {
      return await this.fail(ctx, started, account.accountId, command.canonicalDocumentId, failure({
        tool: TOOL.appendContent,
        operationId: ctx.operationId,
        code: "RATE_LIMITED",
        message: "The account is over its local append limit.",
        retryable: true,
        retryAfterSeconds: limit.retryAfterSeconds,
      }));
    }

    try {
    const hash = requestHash({
      account_id: account.accountId,
      document_id: command.canonicalDocumentId,
      content: command.content,
      format: command.format,
      prepend_newline: command.prependNewline,
    });
    const idem = await this.idempotency.begin(ctx, TOOL.appendContent, command.idempotencyKey, hash);
    if (idem.type === "replay" || idem.type === "stop") {
      const envelope = idem.envelope as Envelope<DocsAppendResult>;
      await this.auditWrite(ctx, started, account.accountId, command.canonicalDocumentId, envelope, idem.type === "replay");
      return envelope;
    }

    const warnings = command.idempotencyKey ? [] : [WARNING.idempotencyKeyMissing];
    try {
      const accessToken = await this.tokens.getAccessToken(ctx, account);
      const appended = await this.docs.appendText(
        accessToken,
        command.canonicalDocumentId,
        command.content,
        command.prependNewline,
      );
      const result: DocsAppendResult = {
        document_id: appended.documentId,
        account_id: account.accountId,
        status: "appended",
        start_index: appended.startIndex,
        end_index: appended.endIndex,
        base_revision_id: appended.baseRevisionId,
        document_title: appended.documentTitle,
      };
      if (appended.revisionId) result.revision_id = appended.revisionId;
      const envelope = success(TOOL.appendContent, ctx.operationId, result, warnings);
      await this.idempotency.complete(ctx, TOOL.appendContent, command.idempotencyKey, envelope);
      await this.auditWrite(ctx, started, account.accountId, command.canonicalDocumentId, envelope, false);
      this.logger.info("docs append submitted", {
        operation_id: ctx.operationId,
        tool: TOOL.appendContent,
        account_id: account.accountId,
        document_id: command.canonicalDocumentId,
      });
      return envelope;
    } catch (error) {
      if (error instanceof GoogleApiError) {
        this.metrics.increment("google_api_errors_total", { api: "docs", error_code: error.code });
      }
      const api = error instanceof GoogleApiError
        ? error
        : new GoogleApiError({ code: "INTERNAL_ERROR", message: "The append could not be completed." });
      if (api.code === "UNAUTHENTICATED") {
        await this.store.markReauthorizationRequired(ctx.tenantId, ctx.userId, account.accountId, this.clock().toISOString());
        this.tokens.drop(account.accountId);
      }
      const envelope = failure({
        tool: TOOL.appendContent,
        operationId: ctx.operationId,
        code: api.code,
        message: api.code === "NOT_FOUND" ? "The document was not found." : api.message,
        retryable: api.ambiguous ? false : api.retryable,
        retryAfterSeconds: api.retryAfterSeconds,
        nextAction: api.code === "UNAUTHENTICATED" || api.code === "INSUFFICIENT_SCOPE"
          ? "Call google_begin_authorization with capability docs.append for this account."
          : api.code === "CONFLICT"
            ? "The append was retried against the latest revision and still conflicted. Try again with a new idempotency key."
            : undefined,
      });
      if (api.ambiguous) await this.idempotency.markUnknown(ctx, TOOL.appendContent, command.idempotencyKey, envelope);
      else await this.idempotency.fail(ctx, TOOL.appendContent, command.idempotencyKey, envelope);
      await this.auditWrite(ctx, started, account.accountId, command.canonicalDocumentId, envelope, false);
      this.logger.error("docs append failed", {
        operation_id: ctx.operationId,
        tool: TOOL.appendContent,
        error_code: api.code,
        account_id: account.accountId,
        document_id: command.canonicalDocumentId,
      });
      return envelope;
    }
    } finally {
      this.rateLimiter.release(limitRequest);
    }
  }

  private async resolve(ctx: InvocationContext, accountId: string | undefined): Promise<AccountRecord | null> {
    if (accountId) return this.store.getAccount(ctx.tenantId, ctx.userId, accountId);
    if (this.config.defaultAccountId) {
      return this.store.getAccount(ctx.tenantId, ctx.userId, this.config.defaultAccountId);
    }
    return this.store.getDefaultAccount(ctx.tenantId, ctx.userId);
  }

  private async fail(
    ctx: InvocationContext,
    started: number,
    accountId: string | null,
    documentId: string | null,
    envelope: FailureEnvelope,
  ): Promise<FailureEnvelope> {
    await this.auditWrite(ctx, started, accountId, documentId, envelope, false);
    return envelope;
  }

  private async auditWrite(
    ctx: InvocationContext,
    started: number,
    accountId: string | null,
    documentId: string | null,
    envelope: Envelope,
    replay: boolean,
  ): Promise<void> {
    await this.audit.write({
      operation_id: envelope.operation_id,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      account_id: accountId,
      tool: TOOL.appendContent,
      outcome: replay ? "replay" : envelope.ok ? "success" : "error",
      error_code: envelope.ok ? "" : envelope.error.code,
      latency_ms: Date.now() - started,
      idempotency_replay: replay,
      ...(documentId ? { document_id: documentId } : {}),
      created_at: this.clock().toISOString(),
    });
  }
}
