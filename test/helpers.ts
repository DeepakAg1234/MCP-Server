import { randomBytes } from "node:crypto";
import type { AppConfig } from "../src/config/env.js";
import { loadConfig } from "../src/config/env.js";
import { createApp, type App } from "../src/app/create-app.js";
import type { TokenStore } from "../src/auth/token-store.js";
import { invocationContext, type InvocationContext } from "../src/domain/context.js";
import { createOperationId } from "../src/domain/ids.js";
import { SCOPE } from "../src/domain/tools.js";
import { MemoryAuditWriter } from "../src/observability/audit.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    TOKEN_STORE_SQLITE_PATH: ":memory:",
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    TENANT_ID: "tenant-a",
    USER_ID: "user-a",
    LOG_CONTENT: "false",
    UPSTREAM_MAX_ATTEMPTS: "0",
  });
  return { ...base, ...overrides };
}

export function testContext(overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    ...invocationContext({
      operationId: createOperationId(),
      tenantId: "tenant-a",
      userId: "user-a",
    }),
    ...overrides,
  };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function fakeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

export async function openTestApp(options: {
  config?: AppConfig;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  gmailTimeoutMs?: number;
  docsTimeoutMs?: number;
  store?: TokenStore;
} = {}): Promise<App & { auditLog: MemoryAuditWriter }> {
  const auditLog = new MemoryAuditWriter();
  const app = await createApp({
    config: options.config ?? testConfig(),
    fetchImpl: options.fetchImpl ?? (async () => jsonResponse(500, { error: { message: "unexpected fetch" } })),
    audit: auditLog,
    clock: options.clock,
    sleep: async () => undefined,
    gmailTimeoutMs: options.gmailTimeoutMs,
    docsTimeoutMs: options.docsTimeoutMs,
    store: options.store,
    logger: {
      debug: () => "",
      info: () => "",
      warn: () => "",
      error: () => "",
      addSecret: () => undefined,
    },
  });
  return Object.assign(app, { auditLog });
}

export async function seedAccount(
  app: App,
  ctx: InvocationContext,
  input: {
    sub?: string;
    email?: string;
    scopes?: string[];
    refreshToken?: string;
  } = {},
) {
  return app.store.upsertConsent({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    googleSub: input.sub ?? "google-sub-1",
    email: input.email ?? "ada@example.com",
    displayName: "Ada Lovelace",
    grantedScopes: input.scopes ?? [SCOPE.openid, SCOPE.email, SCOPE.profile, SCOPE.gmailSend, SCOPE.documents],
    refreshToken: input.refreshToken ?? "refresh-token-secret-value",
    now: new Date().toISOString(),
  });
}
