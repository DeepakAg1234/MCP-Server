import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createApp } from "../../src/app/create-app.js";
import type { AppConfig } from "../../src/config/env.js";
import { testConfig, seedAccount, testContext } from "../helpers.js";

export const ROOT = join(import.meta.dirname, "../..");
export const SERVER_ENTRY = join(ROOT, "dist", "index.js");

export const PLANTED = {
  refresh: "refresh-token-planted-value-0123456789",
  access: "ya29.planted-access-token-value",
  secret: "planted-client-secret-value",
  body: "Body text that must not be audited",
  bcc: "hidden-bcc@secret.example",
};

export const DOC_ID = "1AbCdEfGhIjKlMnOpQrSt";

export type FakeGoogle = {
  port: number;
  origin: string;
  calls: { token: number; gmail: number; docsGet: number; docsUpdate: number; unexpected: string[] };
  close: () => Promise<void>;
};

export function startFakeGoogle(): Promise<FakeGoogle> {
  const calls = { token: 0, gmail: 0, docsGet: 0, docsUpdate: 0, unexpected: [] as string[] };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "POST" && url.pathname === "/token") {
        calls.token += 1;
        send(200, { access_token: PLANTED.access, expires_in: 3600, token_type: "Bearer" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/gmail/v1/users/me/messages/send") {
        calls.gmail += 1;
        send(200, { id: "msg-contract-1", threadId: "thread-contract-1" });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/documents/")) {
        calls.docsGet += 1;
        send(200, {
          revisionId: "rev-1",
          title: "Notes",
          body: { content: [{ endIndex: 2 }] },
        });
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith(":batchUpdate")) {
        calls.docsUpdate += 1;
        send(200, { revisionId: "rev-2" });
        return;
      }
      calls.unexpected.push(`${request.method ?? "GET"} ${url.pathname}`);
      send(404, {});
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fake Google did not bind a port"));
        return;
      }
      resolve({
        port: address.port,
        origin: `http://127.0.0.1:${address.port}`,
        calls,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

export function workspaceDir(): string {
  return mkdtempSync(join(tmpdir(), "gmail-docs-mcp-"));
}

export async function seedUser(options: {
  dbPath: string;
  key: string;
  userId: string;
  email: string;
  sub: string;
  refreshToken?: string;
  extra?: Partial<AppConfig>;
}): string {
  const config = testConfig({
    tokenStoreSqlitePath: options.dbPath,
    tokenEncryptionKey: options.key,
    tenantId: "local",
    userId: options.userId,
    googleOauthClientId: "test-client-id",
    googleOauthClientSecret: PLANTED.secret,
    ...options.extra,
  });
  const app = await createApp({ config, fetchImpl: async () => new Response("{}", { status: 500 }) });
  const account = await seedAccount(app, testContext({ tenantId: "local", userId: options.userId }), {
    email: options.email,
    sub: options.sub,
    refreshToken: options.refreshToken ?? PLANTED.refresh,
  });
  await app.close();
  return account.accountId;
}

export function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.GOOGLE_API_ORIGIN;
  delete env.MCP_STDOUT_TEE;
  return { ...env, TRANSPORT: "stdio", ...overrides };
}

export async function connectServer(
  env: Record<string, string>,
  mode: "legacy" | { pin: "2026-07-28" } = { pin: "2026-07-28" },
): Promise<{
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}> {
  const chunks: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: ROOT,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
  const client = new Client(
    { name: "contract-harness", version: "0.1.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  return {
    client,
    stderr: () => Buffer.concat(chunks).toString("utf8"),
    close: async () => {
      await client.close();
    },
  };
}
