import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { devBearerHash } from "../../src/auth/mcp-principal.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env } });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

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

describe("process startup", () => {
  it("exits before listening when HTTP is paired with SQLite without the replica flag", async () => {
    const port = await freePort();
    const result = await runNode([tsx, "src/index.ts"], {
      TRANSPORT: "http",
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      GOOGLE_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/google/callback`,
      MCP_DEV_BEARER_SHA256: devBearerHash("dev"),
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      TOKEN_STORE: "sqlite",
      ALLOW_SINGLE_REPLICA_SQLITE: "false",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ALLOW_SINGLE_REPLICA_SQLITE/);
    expect(result.stdout).toBe("");
  });

  it("refuses to start in production when the development bearer is set", async () => {
    const port = await freePort();
    const result = await runNode([tsx, "src/index.ts"], {
      TRANSPORT: "http",
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      GOOGLE_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/google/callback`,
      MCP_AUTHORIZATION_SERVER: "https://issuer.example",
      MCP_DEV_BEARER_SHA256: devBearerHash("dev"),
      NODE_ENV: "production",
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      TOKEN_STORE_SQLITE_PATH: join(mkdtempSync(join(tmpdir(), "mcp-startup-")), "tokens.sqlite"),
      ALLOW_SINGLE_REPLICA_SQLITE: "true",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/MCP_DEV_BEARER_SHA256/);
    expect(result.stdout).toBe("");
  });
});
