import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_NAMES, assertEncryptionKey, loadConfig } from "../../src/config/env.js";
import { ERROR_CODES, defaultRetryable } from "../../src/domain/errors.js";
import { failure } from "../../src/domain/envelope.js";
import { createOperationId } from "../../src/domain/ids.js";
import { decideStartup } from "../../src/config/startup.js";
import { listSchemaFiles, parseGmailSendInput, validateSchema } from "../../src/tools/validate.js";
import { testConfig } from "../helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("config", () => {
  it("parses defaults and accepts http without listening", () => {
    const config = loadConfig({ TOKEN_ENCRYPTION_KEY: "" });
    expect(config.transport).toBe("stdio");
    expect(config.tokenStore).toBe("sqlite");
    expect(config.maxRecipients).toBe(50);
    expect(config.logContent).toBe(false);
    expect(() => assertEncryptionKey(config)).toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(loadConfig({ TRANSPORT: "http" }).transport).toBe("http");
    const http = decideStartup(loadConfig({ TRANSPORT: "http" }));
    expect(http).toMatchObject({ action: "exit", exitCode: 1 });
    if (http.action === "exit") expect(http.message).toMatch(/PUBLIC_BASE_URL/);
    expect(decideStartup(loadConfig({ TRANSPORT: "stdio" }))).toEqual({ action: "serve" });
  });

  it("uses Railway runtime defaults when the platform variables are set", () => {
    const config = loadConfig({
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      DATABASE_URL: "postgres://user:secret@postgres.railway.internal:5432/railway",
      PORT: "4321",
      MCP_DEV_BEARER_SHA256: "abc",
      NODE_ENV: "development",
    });
    expect(config.transport).toBe("http");
    expect(config.host).toBe("::");
    expect(config.port).toBe(4321);
    expect(config.publicBaseUrl).toBe("https://app.up.railway.app");
    expect(config.googleRedirectUri).toBe("https://app.up.railway.app/oauth/google/callback");
    expect(config.mcpResourceAudience).toBe("https://app.up.railway.app");
    expect(config.tokenStore).toBe("postgres");
    expect(config.tokenStoreDatabaseUrl).toContain("postgres.railway.internal");
    expect(decideStartup(config)).toEqual({ action: "serve" });
    expect(
      loadConfig({
        RAILWAY_ENVIRONMENT: "production",
        HOST: "127.0.0.1",
        TRANSPORT: "stdio",
        TOKEN_STORE: "sqlite",
        PUBLIC_BASE_URL: "https://custom.example",
        TOKEN_STORE_DATABASE_URL: "postgres://explicit/db",
        DATABASE_URL: "postgres://ignored/db",
      }),
    ).toMatchObject({
      host: "127.0.0.1",
      transport: "stdio",
      tokenStore: "sqlite",
      publicBaseUrl: "https://custom.example",
      tokenStoreDatabaseUrl: "postgres://explicit/db",
    });
    const production = decideStartup(
      loadConfig({
        RAILWAY_ENVIRONMENT: "production",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
        DATABASE_URL: "postgres://user:secret@postgres.railway.internal:5432/railway",
        NODE_ENV: "production",
        MCP_DEV_BEARER_SHA256: "abc",
      }),
    );
    expect(production).toMatchObject({ action: "exit" });
  });

  it("fails closed on invalid values", () => {
    expect(() => loadConfig({ ALLOW_MISSING_TO: "yes" })).toThrow(/ALLOW_MISSING_TO/);
    expect(() => loadConfig({ TRANSPORT: "sse" })).toThrow(/TRANSPORT/);
  });

  it("documents every parsed variable in .env.example", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    for (const name of ENV_NAMES) {
      expect(example).toContain(name);
    }
    expect(example).not.toMatch(/ya29\./);
    expect(example).not.toMatch(/GOCSPX-/);
  });
});

describe("errors", () => {
  it("requires retryable and sets retry_after for rate limits and in-flight leases", () => {
    for (const code of ERROR_CODES) {
      const envelope = failure({
        tool: "gmail_send_email",
        operationId: createOperationId(),
        code,
        message: "safe message",
        ...(code === "CONFLICT" ? { retryable: true, retryAfterSeconds: 12 } : {}),
      });
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(typeof envelope.error.retryable).toBe("boolean");
        expect(envelope.error.error_id).toBe(envelope.operation_id);
        if (code === "RATE_LIMITED") expect(envelope.error.retry_after_seconds).toBe(60);
        if (code === "CONFLICT") expect(envelope.error.retry_after_seconds).toBe(12);
        expect(envelope.error.retryable).toBe(code === "CONFLICT" ? true : defaultRetryable(code));
      }
    }
  });
});

describe("schemas", () => {
  const limits = testConfig();

  it("accepts each published example", () => {
    for (const file of listSchemaFiles()) {
      const examples = file.schema.examples;
      if (Array.isArray(examples)) {
        for (const example of examples) {
          const id = String(file.schema.$id);
          expect(validateSchema(id, example), `${file.name} example`).toEqual({ ok: true });
        }
      }
      const output = (file.schema.$defs as { output?: { $id?: string; examples?: unknown[] } } | undefined)?.output;
      for (const example of output?.examples ?? []) {
        expect(validateSchema(String(output?.$id), example), `${file.name} output`).toEqual({ ok: true });
      }
    }
  });

  it("rejects unknown fields, empty to, attachments, bad format, and oversized bodies", () => {
    const base = { to: ["ada@example.com"], subject: "Hello", body: "Hi" };
    expect(parseGmailSendInput({ ...base, extra: true }, limits).ok).toBe(false);
    expect(parseGmailSendInput({ ...base, to: [] }, limits)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/to must contain/),
    });
    const attachments = parseGmailSendInput({ ...base, attachments: [] }, limits);
    expect(attachments.ok).toBe(false);
    if (!attachments.ok) expect(attachments.message).toMatch(/attachments/);
    expect(parseGmailSendInput({ ...base, body_format: "markdown" }, limits).ok).toBe(false);
    const huge = parseGmailSendInput({ ...base, body: "x".repeat(limits.maxBodyBytes + 1) }, limits);
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.message).toMatch(/MAX_BODY_BYTES/);
  });

  it("has no drifted published copy", () => {
    const published = join(root, "schemas");
    if (!existsSync(published)) {
      expect(existsSync(published)).toBe(false);
      return;
    }
    const source = join(root, "src", "tools", "schemas");
    for (const name of readdirSync(source)) {
      expect(readFileSync(join(published, name), "utf8")).toBe(readFileSync(join(source, name), "utf8"));
    }
  });
});
