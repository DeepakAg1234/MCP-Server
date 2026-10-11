import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failure, success } from "../../src/domain/envelope.js";
import { createOperationId } from "../../src/domain/ids.js";
import { envelopeToToolResult } from "../../src/mcp/result.js";
import { noopMetrics } from "../../src/observability/metrics.js";
import { EnvAllowlistPolicy } from "../../src/policy/allowlist.js";
import { InProcessRateLimiter } from "../../src/policy/in-process-rate-limiter.js";
import { TOOL } from "../../src/domain/tools.js";
import { testConfig, openTestApp, seedAccount, testContext, jsonResponse } from "../helpers.js";

describe("result mapper", () => {
  it("puts the envelope in structured content and text, and flags errors", () => {
    const ok = success(TOOL.listAccounts, createOperationId(), { accounts: [] });
    const mapped = envelopeToToolResult(ok);
    expect(mapped.isError).toBe(false);
    expect(mapped.structuredContent).toEqual(ok);
    expect(mapped.content?.[0]).toEqual({ type: "text", text: JSON.stringify(ok) });

    const denied = failure({
      tool: TOOL.sendEmail,
      operationId: createOperationId(),
      code: "ACCESS_DENIED",
      message: "recipient domain is not allowed",
    });
    const failed = envelopeToToolResult(denied);
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toEqual(denied);
    expect(JSON.parse((failed.content?.[0] as { text: string }).text)).toEqual(denied);
  });
});

describe("allowlists", () => {
  const policy = new EnvAllowlistPolicy(
    testConfig({
      allowAccountIds: ["acct_allowed"],
      allowRecipientDomains: ["example.com"],
      allowBccDomains: [],
      allowDocumentIds: ["doc-allowed"],
    }),
  );

  it("names the policy and does not list rejected BCC addresses", () => {
    expect(policy.evaluate({ tool: TOOL.sendEmail, accountId: "acct_other" })).toEqual({
      allowed: false,
      message: "account is not allowed",
    });
    const recipient = policy.evaluate({
      tool: TOOL.sendEmail,
      accountId: "acct_allowed",
      recipientDomains: ["other.test"],
      bccDomains: ["secret.example"],
    });
    expect(recipient.allowed).toBe(false);
    if (!recipient.allowed) expect(recipient.message).toBe("recipient domain is not allowed");
    const bcc = policy.evaluate({
      tool: TOOL.sendEmail,
      accountId: "acct_allowed",
      recipientDomains: ["example.com"],
      bccDomains: ["secret.example"],
    });
    expect(bcc.allowed).toBe(false);
    if (!bcc.allowed) expect(bcc.message).toBe("bcc domain is not allowed");
    expect(JSON.stringify(bcc)).not.toContain("secret.example");
    expect(
      policy.evaluate({
        tool: TOOL.appendContent,
        accountId: "acct_allowed",
        documentId: "doc-other",
      }),
    ).toEqual({ allowed: false, message: "document is not allowed" });
  });
});

describe("rate limiter", () => {
  it("returns a retry delay after the per-account budget is spent", () => {
    const limiter = new InProcessRateLimiter(
      { perAccountPerMinute: 1, perPrincipalPerMinute: 60, maxConcurrencyPerAccount: 2 },
      noopMetrics,
      () => 1_000_000,
    );
    const request = { tool: TOOL.sendEmail, accountId: "acct_1", tenantId: "local", userId: "local" };
    expect(limiter.take(request).allowed).toBe(true);
    limiter.release(request);
    const second = limiter.take(request);
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("retention", () => {
  it("deletes expired audit and completed idempotency rows, then treats the key as new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-retention-"));
    const config = testConfig({
      tokenStoreSqlitePath: join(dir, "tokens.sqlite"),
      auditRetentionDays: 30,
      idempotencyTtlHours: 24,
    });
    const idemOld = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const auditOld = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const first = await openTestApp({ config });
    const ctx = testContext();
    await first.store.insertOperation({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      tool: TOOL.sendEmail,
      idempotencyKey: "reused",
      requestHash: "old-hash",
      status: "completed",
      leaseUntil: null,
      operationId: createOperationId(),
      envelopeJson: "{}",
      createdAt: idemOld,
      updatedAt: idemOld,
    });
    await first.store.insertOperation({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      tool: TOOL.sendEmail,
      idempotencyKey: "held",
      requestHash: "held-hash",
      status: "reserved",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      operationId: createOperationId(),
      envelopeJson: null,
      createdAt: idemOld,
      updatedAt: idemOld,
    });
    await first.store.insertAudit({
      operation_id: createOperationId(),
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      account_id: null,
      tool: TOOL.sendEmail,
      outcome: "success",
      error_code: "",
      latency_ms: 1,
      idempotency_replay: false,
      created_at: auditOld,
    });
    await first.close();

    let sends = 0;
    const second = await openTestApp({
      config,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/token")) return jsonResponse(200, { access_token: "ya29.retention", expires_in: 3600 });
        if (url.includes("/messages/send")) {
          sends += 1;
          return jsonResponse(200, { id: "m-new", threadId: "t-new" });
        }
        return jsonResponse(404, {});
      },
    });
    expect(await second.store.listAudit(ctx.tenantId, ctx.userId)).toEqual([]);
    expect(await second.store.getOperation(ctx.tenantId, ctx.userId, TOOL.sendEmail, "reused")).toBeNull();
    expect((await second.store.getOperation(ctx.tenantId, ctx.userId, TOOL.sendEmail, "held"))?.status).toBe("reserved");
    await seedAccount(second, ctx);
    const sent = await second.email.send(ctx, {
      to: ["ada@example.com"],
      subject: "Again",
      body: "Hello",
      idempotency_key: "reused",
    });
    expect(sent.ok).toBe(true);
    expect(sends).toBe(1);
    await second.close();
  });
});
