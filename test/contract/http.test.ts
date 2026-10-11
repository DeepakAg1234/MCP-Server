import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL, TOOL_ORDER } from "../../src/domain/tools.js";
import { devBearerHash } from "../../src/auth/mcp-principal.js";
import {
  PLANTED,
  ROOT,
  SERVER_ENTRY,
  childEnv,
  connectServer,
  seedUser,
  startFakeGoogle,
  workspaceDir,
  type FakeGoogle,
} from "./harness.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForOk(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function spawnServer(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
}

async function httpSession(options?: { userId?: string; bearer?: string; metrics?: boolean; metricsToken?: string }): Promise<{
  client: Client;
  baseUrl: string;
  fake: FakeGoogle;
  accountId: string;
  bearer: string;
  close: () => Promise<void>;
}> {
  const dir = workspaceDir();
  const dbPath = join(dir, "tokens.sqlite");
  const key = randomBytes(32).toString("base64");
  const fake = await startFakeGoogle();
  const userId = options?.userId ?? "user-a";
  const bearer = options?.bearer ?? "dev-token-user-a";
  const accountId = await seedUser({ dbPath, key, userId, email: `${userId}@example.com`, sub: `sub-${userId}` });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawnServer(
    childEnv({
      TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      GOOGLE_REDIRECT_URI: `${baseUrl}/oauth/google/callback`,
      ALLOW_SINGLE_REPLICA_SQLITE: "true",
      MCP_DEV_BEARER_SHA256: devBearerEntry(bearer, userId),
      TOKEN_ENCRYPTION_KEY: key,
      TOKEN_STORE_SQLITE_PATH: dbPath,
      GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
      GOOGLE_API_ORIGIN: fake.origin,
      TENANT_ID: "local",
      USER_ID: userId,
      NODE_ENV: "development",
      METRICS_ENABLED: options?.metrics ? "true" : "false",
      ...(options?.metricsToken ? { METRICS_TOKEN: options.metricsToken } : {}),
    }),
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await fake.close();
  };
  closers.push(close);
  try {
    await waitForOk(`${baseUrl}/healthz`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "startup failed"}\n${stderr}`);
  }
  const client = new Client({ name: "http-contract", version: "0.2.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return { client, baseUrl, fake, accountId, bearer, close };
}

function devBearerEntry(token: string, userId: string, tenantId = "local"): string {
  return `${devBearerHash(token)}|${tenantId}|${userId}`;
}

function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

function shape(value: unknown): unknown {
  const envelope = value as {
    ok?: boolean;
    tool?: string;
    result?: Record<string, unknown>;
    warnings?: Array<{ code: string }>;
    error?: { code?: string };
  };
  return {
    ok: envelope.ok,
    tool: envelope.tool,
    result: envelope.result ? Object.keys(envelope.result).sort() : [],
    warnings: (envelope.warnings ?? []).map((warning) => warning.code).sort(),
    error: envelope.error?.code ?? null,
  };
}

describe("streamable http contract", () => {
  it("matches stdio tool discovery and the fake send envelope shape", async () => {
    const dir = workspaceDir();
    const dbPath = join(dir, "tokens.sqlite");
    const key = randomBytes(32).toString("base64");
    const fake = await startFakeGoogle();
    closers.push(() => fake.close());
    const accountId = await seedUser({ dbPath, key, userId: "user-a", email: "user-a@example.com", sub: "sub-user-a" });
    const stdio = await connectServer(
      childEnv({
        TOKEN_ENCRYPTION_KEY: key,
        TOKEN_STORE_SQLITE_PATH: dbPath,
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
        GOOGLE_API_ORIGIN: fake.origin,
        TENANT_ID: "local",
        USER_ID: "user-a",
      }),
    );
    closers.push(stdio.close);
    const http = await httpSession();
    const stdioTools = await stdio.client.listTools();
    const httpTools = await http.client.listTools();
    expect(httpTools.tools.map((tool) => tool.name)).toEqual([...TOOL_ORDER]);
    expect(httpTools.tools.map((tool) => tool.name)).toEqual(stdioTools.tools.map((tool) => tool.name));
    expect(httpTools.tools.map((tool) => JSON.stringify(tool.inputSchema))).toEqual(
      stdioTools.tools.map((tool) => JSON.stringify(tool.inputSchema)),
    );
    expect(httpTools.tools.map((tool) => JSON.stringify(tool.outputSchema))).toEqual(
      stdioTools.tools.map((tool) => JSON.stringify(tool.outputSchema)),
    );
    const input = {
      to: ["user-a@example.com"],
      subject: "Hello",
      body: "Same body",
      idempotency_key: "shape-1",
      account_id: accountId,
    };
    const fromStdio = JSON.parse(textOf(await stdio.client.callTool({ name: TOOL.sendEmail, arguments: { ...input, account_id: accountId } })));
    const fromHttp = JSON.parse(textOf(await http.client.callTool({ name: TOOL.sendEmail, arguments: { ...input, account_id: http.accountId } })));
    expect(shape(fromHttp)).toEqual(shape(fromStdio));
    expect(fromHttp.ok).toBe(true);
  }, 40_000);

  it("returns protocol and argument errors, and requires a bearer", async () => {
    const http = await httpSession();
    const missing = await fetch(`${http.baseUrl}/mcp`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
    expect(missing.headers.get("www-authenticate")).toMatch(/scope="tools\.call"/);
    const unsupported = await fetch(`${http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${http.bearer}`,
        "content-type": "application/json",
        "mcp-protocol-version": "1999-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unsupported.status).toBeGreaterThanOrEqual(400);
    expect(unsupported.status).toBeLessThan(500);

    let code: number | undefined;
    try {
      await http.client.callTool({ name: "not_a_real_tool", arguments: {} });
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(-32602);
    const bad = await http.client.callTool({
      name: TOOL.sendEmail,
      arguments: { to: ["user-a@example.com"], subject: "Hello", body: "Hi", extra: true },
    });
    expect(bad.isError).toBe(true);
    expect((JSON.parse(textOf(bad)) as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT");
  }, 30_000);

  it("isolates two development bearers on one database", async () => {
    const dir = workspaceDir();
    const dbPath = join(dir, "tokens.sqlite");
    const key = randomBytes(32).toString("base64");
    const fake = await startFakeGoogle();
    closers.push(() => fake.close());
    const accountA = await seedUser({ dbPath, key, userId: "user-a", email: "a@example.com", sub: "sub-a" });
    const accountB = await seedUser({ dbPath, key, userId: "user-b", email: "b@example.com", sub: "sub-b" });
    const tokenA = "bearer-a";
    const tokenB = "bearer-b";
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawnServer(
      childEnv({
        TRANSPORT: "http",
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_BASE_URL: baseUrl,
        GOOGLE_REDIRECT_URI: `${baseUrl}/oauth/google/callback`,
        ALLOW_SINGLE_REPLICA_SQLITE: "true",
        MCP_DEV_BEARER_SHA256: `${devBearerEntry(tokenA, "user-a")},${devBearerEntry(tokenB, "user-b")}`,
        TOKEN_ENCRYPTION_KEY: key,
        TOKEN_STORE_SQLITE_PATH: dbPath,
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
        GOOGLE_API_ORIGIN: fake.origin,
        NODE_ENV: "development",
      }),
    );
    closers.push(async () => {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    });
    await waitForOk(`${baseUrl}/healthz`);
    const clientFor = async (token: string) => {
      const client = new Client({ name: "http-contract", version: "0.2.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      closers.push(async () => {
        await client.close();
      });
      return client;
    };
    const a = await clientFor(tokenA);
    const b = await clientFor(tokenB);
    const listedA = JSON.parse(textOf(await a.callTool({ name: TOOL.listAccounts, arguments: {} }))) as {
      result: { accounts: Array<{ account_id: string }> };
    };
    const listedB = JSON.parse(textOf(await b.callTool({ name: TOOL.listAccounts, arguments: {} }))) as {
      result: { accounts: Array<{ account_id: string }> };
    };
    expect(listedA.result.accounts.map((account) => account.account_id)).toEqual([accountA]);
    expect(listedB.result.accounts.map((account) => account.account_id)).toEqual([accountB]);
    const foreign = JSON.parse(textOf(await a.callTool({
      name: TOOL.sendEmail,
      arguments: { account_id: accountB, to: ["a@example.com"], subject: "Nope", body: "Nope" },
    }))) as { ok: boolean; error: { code: string } };
    expect(foreign.ok).toBe(false);
    expect(foreign.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(fake.calls.gmail).toBe(0);
  }, 40_000);
});
