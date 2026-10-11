import { describe, expect, it } from "vitest";
import { SCOPE, TOOL } from "../../src/domain/tools.js";
import { TOKEN_URL } from "../../src/google/oauth-client.js";
import { decodeRawMime } from "../../src/google/mime.js";
import { requestHash } from "../../src/domain/hash.js";
import { fakeIdToken, jsonResponse, openTestApp, seedAccount, testConfig, testContext } from "../helpers.js";

const REFRESH = "refresh-token-secret-value";
const ACCESS = "access-token-secret-value";

function tokenOk(extra: Record<string, unknown> = {}) {
  return jsonResponse(200, {
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_in: 3600,
    scope: `${SCOPE.openid} ${SCOPE.email} ${SCOPE.profile} ${SCOPE.gmailSend} ${SCOPE.documents}`,
    id_token: fakeIdToken({ sub: "google-sub-1", email: "ada@example.com", name: "Ada Lovelace" }),
    token_type: "Bearer",
    ...extra,
  });
}

describe("oauth", () => {
  it("stores ciphertext and the display email, and omits verifier material from the result", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      expect(url).toBe(TOKEN_URL);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code_verifier")).toBeTruthy();
      expect(body.get("client_secret")).toBe("test-client-secret");
      return tokenOk();
    };
    const app = await openTestApp({ fetchImpl });
    const ctx = testContext();
    try {
      const redirectUri = "http://127.0.0.1:9/oauth/google/callback";
      const begun = await app.accounts.begin(ctx, { capabilities: ["gmail.send", "docs.append"] }, redirectUri);
      expect(begun.ok).toBe(true);
      if (!begun.ok) return;
      expect(Object.keys(begun.result).sort()).toEqual(["authorization_url", "expires_at", "status"]);
      expect(JSON.stringify(begun.result)).not.toContain("code_verifier");
      const url = new URL(begun.result.authorization_url);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("include_granted_scopes")).toBe("true");
      const finished = await app.oauth.finish(ctx, {
        code: "auth-code",
        state: url.searchParams.get("state") ?? "",
        redirectUri,
      });
      expect(finished.status).toBe(200);
      expect(finished.html).toContain("ada@example.com");
      expect(finished.html).not.toContain(REFRESH);
      expect(finished.html).not.toContain(ACCESS);
      expect(JSON.stringify(finished.envelope)).not.toContain(REFRESH);
      const listed = await app.accounts.list(testContext(), {});
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.result.accounts[0]?.email).toBe("ada@example.com");
      expect(JSON.stringify(listed)).not.toContain(REFRESH);
      const accountId = listed.result.accounts[0]?.account_id ?? "";
      const ciphertext = await app.store.readRefreshCiphertext(ctx.tenantId, ctx.userId, accountId);
      expect(ciphertext?.toString("utf8").includes(REFRESH)).toBe(false);
      expect(await app.store.readRefreshToken(ctx.tenantId, ctx.userId, accountId)).toBe(REFRESH);
    } finally {
      await app.close();
    }
  });

  it("stores nothing when consent is denied", async () => {
    const app = await openTestApp();
    const ctx = testContext();
    try {
      const begun = await app.accounts.begin(ctx, { capabilities: ["gmail.send"] }, "http://127.0.0.1/oauth/google/callback");
      if (!begun.ok) throw new Error("begin failed");
      const state = new URL(begun.result.authorization_url).searchParams.get("state") ?? "";
      const denied = await app.oauth.finish(ctx, { error: "access_denied", state, redirectUri: "http://127.0.0.1/oauth/google/callback" });
      expect(denied.envelope.ok).toBe(false);
      expect(await app.store.listAccounts(ctx.tenantId, ctx.userId)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects expired state, reused state, and state from another principal", async () => {
    let now = new Date("2026-10-10T00:00:00.000Z");
    const fetchImpl: typeof fetch = async () => tokenOk();
    const app = await openTestApp({ fetchImpl, clock: () => now, config: testConfig({ oauthStateTtlSeconds: 600 }) });
    const owner = testContext();
    const other = testContext({ userId: "user-b" });
    try {
      const redirectUri = "http://127.0.0.1/oauth/google/callback";
      const begun = await app.accounts.begin(owner, { capabilities: ["gmail.send"] }, redirectUri);
      if (!begun.ok) throw new Error("begin failed");
      const state = new URL(begun.result.authorization_url).searchParams.get("state") ?? "";
      const foreign = await app.oauth.finish(other, { code: "code-1", state, redirectUri });
      expect(foreign.envelope.ok).toBe(false);
      expect(await app.store.listAccounts(owner.tenantId, owner.userId)).toEqual([]);

      now = new Date("2026-10-10T00:11:00.000Z");
      const expired = await app.oauth.finish(owner, { code: "code-1", state, redirectUri });
      expect(expired.envelope.ok).toBe(false);
      expect(await app.store.listAccounts(owner.tenantId, owner.userId)).toEqual([]);

      now = new Date("2026-10-10T00:00:00.000Z");
      const again = await app.accounts.begin(owner, { capabilities: ["gmail.send"] }, redirectUri);
      if (!again.ok) throw new Error("begin failed");
      const fresh = new URL(again.result.authorization_url).searchParams.get("state") ?? "";
      const first = await app.oauth.finish(owner, { code: "code-2", state: fresh, redirectUri });
      expect(first.envelope.ok).toBe(true);
      const reused = await app.oauth.finish(owner, { code: "code-2", state: fresh, redirectUri });
      expect(reused.envelope.ok).toBe(false);
      expect(await app.store.listAccounts(owner.tenantId, owner.userId)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("marks the account for reauthorization when refresh returns invalid_grant", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(400, { error: "invalid_grant", error_description: REFRESH });
    const app = await openTestApp({ fetchImpl });
    const ctx = testContext();
    try {
      const account = await seedAccount(app, ctx, { refreshToken: REFRESH });
      const sent = await app.email.send(ctx, {
        to: ["bob@example.com"],
        subject: "Hello",
        body: "Hi",
        idempotency_key: "refresh-1",
      });
      expect(sent.ok).toBe(false);
      if (!sent.ok) expect(sent.error.code).toBe("UNAUTHENTICATED");
      const stored = await app.store.getAccount(ctx.tenantId, ctx.userId, account.accountId);
      expect(stored?.status).toBe("reauthorization_required");
      expect(await app.store.readRefreshCiphertext(ctx.tenantId, ctx.userId, account.accountId)).toBeNull();
      expect(JSON.stringify(sent)).not.toContain(REFRESH);
    } finally {
      await app.close();
    }
  });

  it("returns INSUFFICIENT_SCOPE when gmail.send was not granted", async () => {
    let sends = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("gmail.googleapis.com")) sends += 1;
      return tokenOk({ scope: `${SCOPE.openid} ${SCOPE.email} ${SCOPE.profile} ${SCOPE.documents}` });
    };
    const app = await openTestApp({ fetchImpl });
    const ctx = testContext();
    try {
      const redirectUri = "http://127.0.0.1/oauth/google/callback";
      const begun = await app.accounts.begin(ctx, { capabilities: ["docs.append"] }, redirectUri);
      if (!begun.ok) throw new Error("begin failed");
      const state = new URL(begun.result.authorization_url).searchParams.get("state") ?? "";
      expect((await app.oauth.finish(ctx, { code: "code", state, redirectUri })).envelope.ok).toBe(true);
      const status = await app.accounts.status(testContext(), { capability: "gmail.send" });
      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.result.authorized).toBe(false);
        expect(status.result.missing_scopes).toContain(SCOPE.gmailSend);
      }
      const sent = await app.email.send(testContext(), {
        to: ["bob@example.com"],
        subject: "Hello",
        body: "Hi",
      });
      expect(sent.ok).toBe(false);
      if (!sent.ok) expect(sent.error.code).toBe("INSUFFICIENT_SCOPE");
      expect(sends).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("gmail and idempotency", () => {
  it("sends, replays, conflicts, retries a definitive failure, and hides bcc", async () => {
    const sendBodies: string[] = [];
    let mode: "ok" | "not-found" = "ok";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return jsonResponse(200, { access_token: ACCESS, expires_in: 3600, token_type: "Bearer" });
      }
      sendBodies.push(String(init?.body));
      if (mode === "not-found") return jsonResponse(404, { error: { message: "missing mailbox secret" } });
      return jsonResponse(200, { id: "msg-1", threadId: "thread-1" });
    };
    const app = await openTestApp({ fetchImpl });
    const ctx = testContext();
    try {
      await seedAccount(app, ctx);
      const request = {
        to: ["bob@example.com"],
        bcc: ["hidden@example.com"],
        subject: "Hello",
        body: "Hi there",
        idempotency_key: "send-1",
      };
      mode = "not-found";
      const failed = await app.email.send(testContext(), request);
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.error.code).toBe("NOT_FOUND");
        expect(failed.error.message).not.toContain("missing mailbox secret");
      }
      mode = "ok";
      const sent = await app.email.send(testContext(), request);
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect(sent.result).toMatchObject({ message_id: "msg-1", thread_id: "thread-1", status: "sent", recipient_count: 2 });
      expect(sent.warnings.map((warning) => warning.code)).toContain("DELIVERY_NOT_GUARANTEED");
      expect(JSON.stringify(sent)).not.toContain("hidden@example.com");
      const raw = decodeRawMime(JSON.parse(sendBodies[1] ?? "{}").raw as string);
      expect(raw).toContain("Bcc: hidden@example.com");
      expect(sendBodies).toHaveLength(2);

      const replay = await app.email.send(testContext(), request);
      expect(replay.ok).toBe(true);
      if (replay.ok) {
        expect(replay.operation_id).toBe(sent.operation_id);
        expect(replay.warnings.map((warning) => warning.code)).toContain("IDEMPOTENCY_REPLAY");
      }
      expect(sendBodies).toHaveLength(2);

      const conflict = await app.email.send(testContext(), { ...request, body: "Different" });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(sendBodies).toHaveLength(2);

      const reply = await app.email.send(testContext(), {
        to: ["bob@example.com"],
        subject: "Re",
        body: "Reply",
        reply_to_message_id: "msg-1",
        idempotency_key: "send-2",
      });
      expect(reply.ok).toBe(true);
      expect(JSON.parse(sendBodies.at(-1) ?? "{}").threadId).toBe("thread-1");
      const unknownReply = await app.email.send(testContext(), {
        to: ["bob@example.com"],
        subject: "Re",
        body: "Reply",
        reply_to_message_id: "not-ours",
      });
      expect(unknownReply.ok).toBe(false);
      if (!unknownReply.ok) expect(unknownReply.error.code).toBe("INVALID_ARGUMENT");
    } finally {
      await app.close();
    }
  });

  it("records HTML_SANITIZED and replays the sanitized message", async () => {
    let sends = 0;
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input) === TOKEN_URL) return jsonResponse(200, { access_token: ACCESS, expires_in: 3600 });
      sends += 1;
      bodies.push(String(init?.body));
      return jsonResponse(200, { id: "msg-html", threadId: "thread-html" });
    };
    const app = await openTestApp({ fetchImpl });
    const ctx = testContext();
    try {
      await seedAccount(app, ctx);
      const request = {
        to: ["bob@example.com"],
        subject: "Hello",
        body: '<p>Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
        body_format: "html" as const,
        idempotency_key: "html-1",
      };
      const sent = await app.email.send(testContext(), request);
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect(sent.warnings.map((warning) => warning.code)).toContain("HTML_SANITIZED");
      const raw = decodeRawMime(JSON.parse(bodies[0] ?? "{}").raw as string);
      expect(raw).not.toMatch(/<script/i);
      expect(raw).not.toMatch(/javascript:/i);
      const replay = await app.email.send(testContext(), request);
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.warnings.map((warning) => warning.code)).toContain("IDEMPOTENCY_REPLAY");
      expect(sends).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("turns a send timeout into unknown and does not call Gmail again", async () => {
    let sends = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === TOKEN_URL) return jsonResponse(200, { access_token: ACCESS, expires_in: 3600 });
      sends += 1;
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
      return jsonResponse(500, {});
    };
    const app = await openTestApp({ fetchImpl, gmailTimeoutMs: 20 });
    const ctx = testContext();
    try {
      await seedAccount(app, ctx);
      const request = {
        to: ["bob@example.com"],
        subject: "Hello",
        body: "Hi",
        idempotency_key: "timeout-1",
      };
      const first = await app.email.send(testContext(), request);
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.error.retryable).toBe(false);
      expect((await app.store.getOperation(ctx.tenantId, ctx.userId, TOOL.sendEmail, "timeout-1"))?.status).toBe("unknown");
      expect(sends).toBe(1);
      const second = await app.email.send(testContext(), request);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe("CONFLICT");
      expect(sends).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("returns 429 with retry_after_seconds", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === TOKEN_URL) return jsonResponse(200, { access_token: ACCESS, expires_in: 3600 });
      return jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "slow down secret" } }, { "retry-after": "7" });
    };
    const app = await openTestApp({ fetchImpl });
    const ctx = testContext();
    try {
      await seedAccount(app, ctx);
      const sent = await app.email.send(testContext(), {
        to: ["bob@example.com"],
        subject: "Hello",
        body: "Hi",
        idempotency_key: "rate-1",
      });
      expect(sent.ok).toBe(false);
      if (!sent.ok) {
        expect(sent.error.code).toBe("RATE_LIMITED");
        expect(sent.error.retry_after_seconds).toBe(7);
        expect(sent.error.retryable).toBe(true);
        expect(sent.error.message).not.toContain("slow down secret");
      }
    } finally {
      await app.close();
    }
  });

  it("treats an expired lease as unknown and does not call Google", async () => {
    let sends = 0;
    const fetchImpl: typeof fetch = async () => {
      sends += 1;
      return jsonResponse(500, {});
    };
    const app = await openTestApp({ fetchImpl });
    const ctx = testContext();
    try {
      const account = await seedAccount(app, ctx);
      const body = "Hi";
      const hash = requestHash({
        account_id: account.accountId,
        to: ["bob@example.com"],
        cc: [],
        bcc: [],
        subject: "Hello",
        body,
        body_format: "plain",
        reply_to_message_id: null,
      });
      await app.store.insertOperation({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        tool: TOOL.sendEmail,
        idempotencyKey: "lease-1",
        requestHash: hash,
        status: "reserved",
        leaseUntil: new Date(Date.now() - 1000).toISOString(),
        operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        envelopeJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const sent = await app.email.send(testContext(), {
        to: ["bob@example.com"],
        subject: "Hello",
        body,
        idempotency_key: "lease-1",
      });
      expect(sent.ok).toBe(false);
      if (!sent.ok) expect(sent.error.code).toBe("CONFLICT");
      expect((await app.store.getOperation(ctx.tenantId, ctx.userId, TOOL.sendEmail, "lease-1"))?.status).toBe("unknown");
      expect(sends).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("docs", () => {
  it("retries one revision conflict inside a single operation", async () => {
    let gets = 0;
    let updates = 0;
    const revisions: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === TOKEN_URL) return jsonResponse(200, { access_token: ACCESS, expires_in: 3600 });
      if (url.includes(":batchUpdate")) {
        updates += 1;
        const body = JSON.parse(String(init?.body)) as { writeControl?: { requiredRevisionId?: string }; requests?: unknown[] };
        revisions.push(body.writeControl?.requiredRevisionId ?? "");
        expect(JSON.stringify(body.requests)).not.toContain("deleteContentRange");
        if (updates === 1) {
          return jsonResponse(400, { error: { status: "FAILED_PRECONDITION", message: "secret document body" } });
        }
        return jsonResponse(200, { writeControl: { requiredRevisionId: "rev-final" } });
      }
      gets += 1;
      const endIndex = gets === 1 ? 2 : 10;
      return jsonResponse(200, {
        title: "Project log",
        revisionId: gets === 1 ? "rev-1" : "rev-2",
        body: { content: [{ endIndex }] },
      });
    };
    const app = await openTestApp({ fetchImpl, config: testConfig({ docsAppendMaxAttempts: 3 }) });
    const ctx = testContext();
    try {
      await seedAccount(app, ctx);
      const appended = await app.docs.append(testContext(), {
        document_id: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrSt/edit",
        content: "Hi",
        idempotency_key: "doc-1",
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) return;
      expect(appended.result.document_id).toBe("1AbCdEfGhIjKlMnOpQrSt");
      expect(appended.result.document_title).toBe("Project log");
      expect(appended.result.start_index).toBe(9);
      expect(appended.result.end_index).toBe(12);
      expect(appended.result.base_revision_id).toBe("rev-2");
      expect(revisions).toEqual(["rev-1", "rev-2"]);
      expect(gets).toBe(2);
      expect(JSON.stringify(appended)).not.toContain("secret document body");
      const replay = await app.docs.append(testContext(), {
        document_id: "1AbCdEfGhIjKlMnOpQrSt",
        content: "Hi",
        idempotency_key: "doc-1",
      });
      expect(replay.ok).toBe(true);
      expect(gets).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("returns CONFLICT when revision retries are exhausted", async () => {
    let updates = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === TOKEN_URL) return jsonResponse(200, { access_token: ACCESS, expires_in: 3600 });
      if (url.includes(":batchUpdate")) {
        updates += 1;
        return jsonResponse(409, { error: { status: "ABORTED", message: "private paragraph" } });
      }
      return jsonResponse(200, {
        title: "Project log",
        revisionId: "rev-1",
        body: { content: [{ endIndex: 2 }] },
      });
    };
    const app = await openTestApp({ fetchImpl, config: testConfig({ docsAppendMaxAttempts: 3 }) });
    const ctx = testContext();
    try {
      await seedAccount(app, ctx);
      const appended = await app.docs.append(testContext(), {
        document_id: "1AbCdEfGhIjKlMnOpQrSt",
        content: "Hi",
        idempotency_key: "doc-conflict",
      });
      expect(updates).toBe(3);
      expect(appended.ok).toBe(false);
      if (!appended.ok) {
        expect(appended.error.code).toBe("CONFLICT");
        expect(appended.error.message).not.toContain("private paragraph");
      }
    } finally {
      await app.close();
    }
  });
});

describe("isolation", () => {
  it("hides principal B's account from principal A", async () => {
    let sends = 0;
    const app = await openTestApp({
      fetchImpl: async () => {
        sends += 1;
        return jsonResponse(500, {});
      },
    });
    const a = testContext({ userId: "user-a" });
    const b = testContext({ userId: "user-b" });
    try {
      const accountB = await seedAccount(app, b, { sub: "sub-b", email: "b@example.com" });
      await seedAccount(app, a, { sub: "sub-a", email: "a@example.com" });
      const listed = await app.accounts.list(a, {});
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.result.accounts.map((account) => account.email)).toEqual(["a@example.com"]);
      }
      const sent = await app.email.send(a, {
        account_id: accountB.accountId,
        to: ["bob@example.com"],
        subject: "Hello",
        body: "Hi",
      });
      expect(sent.ok).toBe(false);
      if (!sent.ok) expect(sent.error.code).toBe("ACCOUNT_NOT_FOUND");
      expect(sends).toBe(0);
    } finally {
      await app.close();
    }
  });
});
