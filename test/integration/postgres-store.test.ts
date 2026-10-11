import { PGlite } from "@electric-sql/pglite";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { PostgresTokenStore } from "../../src/auth/postgres-token-store.js";
import { encryptionKeyFromBase64, TokenCipher } from "../../src/auth/cipher.js";
import type { Sql } from "../../src/auth/sql.js";
import { TOOL } from "../../src/domain/tools.js";
import { jsonResponse, openTestApp, seedAccount, testConfig, testContext } from "../helpers.js";

type Runner = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
};

async function pgliteSql(): Promise<{ sql: Sql; close: () => Promise<void> }> {
  const db = await PGlite.create();
  const current = new AsyncLocalStorage<Runner>();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await db.close();
  };
  const sql: Sql = {
    inTransaction() {
      return current.getStore() !== undefined;
    },
    async query(text, params = []) {
      const runner = current.getStore() ?? db;
      const result = await runner.query(text, params);
      return { rows: result.rows as never[], rowCount: result.affectedRows ?? result.rows.length };
    },
    async transaction(fn) {
      if (current.getStore()) return fn();
      return db.transaction(async (tx) => current.run(tx, fn));
    },
    close,
  };
  return { sql, close };
}

describe("postgres token store", () => {
  it("replays a completed send and keeps an unknown lease from calling Google", async () => {
    const { sql, close } = await pgliteSql();
    const config = testConfig({ tokenStore: "postgres", tokenStoreDatabaseUrl: "postgres://unused" });
    const store = new PostgresTokenStore(sql, new TokenCipher(encryptionKeyFromBase64(config.tokenEncryptionKey)));
    let sends = 0;
    const app = await openTestApp({
      config,
      store,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/token")) return jsonResponse(200, { access_token: "ya29.pg", expires_in: 3600 });
        if (url.includes("/messages/send")) {
          sends += 1;
          return jsonResponse(200, { id: "msg-pg", threadId: "thread-pg" });
        }
        return jsonResponse(404, {});
      },
    });
    const ctx = testContext();
    await seedAccount(app, ctx);
    const request = { to: ["ada@example.com"], subject: "Hello", body: "Body", idempotency_key: "pg-1" };
    const first = await app.email.send(ctx, request);
    const replay = await app.email.send(ctx, request);
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.warnings.some((warning) => warning.code === "IDEMPOTENCY_REPLAY")).toBe(true);
    expect(sends).toBe(1);

    const hung = await openTestApp({
      config,
      store,
      gmailTimeoutMs: 20,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/token")) return jsonResponse(200, { access_token: "ya29.pg", expires_in: 3600 });
        if (url.includes("/messages/send")) {
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
        }
        return jsonResponse(404, {});
      },
    });
    const unknown = await hung.email.send(testContext(), { ...request, idempotency_key: "pg-unknown" });
    expect(unknown.ok).toBe(false);
    expect((await store.getOperation(ctx.tenantId, ctx.userId, TOOL.sendEmail, "pg-unknown"))?.status).toBe("unknown");
    const again = await hung.email.send(testContext(), { ...request, idempotency_key: "pg-unknown" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("CONFLICT");
    await hung.close();
    await app.close();
    await close();
  }, 30_000);

  it("closes", async () => {
    const { sql, close } = await pgliteSql();
    const config = testConfig();
    const store = new PostgresTokenStore(sql, new TokenCipher(encryptionKeyFromBase64(config.tokenEncryptionKey)));
    await store.ready();
    await store.ping();
    await close();
  });
});
