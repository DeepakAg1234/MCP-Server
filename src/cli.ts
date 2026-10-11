#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createApp } from "./app/create-app.js";
import { assertGoogleClient, loadConfig } from "./config/env.js";
import { loadEnvFile } from "./config/load-env-file.js";
import { invocationContext } from "./domain/context.js";
import { ConfigError } from "./domain/errors.js";
import type { Envelope } from "./domain/envelope.js";
import { createOperationId } from "./domain/ids.js";
import type { Capability } from "./domain/tools.js";
import { listenForCallback } from "./auth/oauth-flow.js";

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  openUrl?: (url: string) => void;
  env: NodeJS.ProcessEnv;
};

function printHelp(): string {
  return [
    "google-workspace-mcp",
    "",
    "Operator commands. They call the same services as the MCP tools.",
    "They are not a second public API.",
    "",
    "  auth [--capability gmail.send] [--capability docs.append]",
    "  accounts",
    "  send --file <request.json>",
    "  append --file <request.json>",
    "",
    "auth opens a loopback browser flow and stores an encrypted refresh token.",
    "send and append read a JSON object matching the tool input schema.",
  ].join("\n");
}

function parseArgs(argv: string[]): { command: string | undefined; flags: Map<string, string[]> } {
  const [command, ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) {
      throw new ConfigError(`Unexpected argument ${token ?? ""}`.trim());
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ConfigError(`Missing value for --${key}`);
    }
    index += 1;
    const existing = flags.get(key) ?? [];
    existing.push(value);
    flags.set(key, existing);
  }
  return { command, flags };
}

function openUrl(url: string): void {
  if (process.env.GOOGLE_WORKSPACE_MCP_NO_BROWSER === "1") return;
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

function printEnvelope(io: CliIo, envelope: Envelope): number {
  io.stdout(JSON.stringify(envelope, null, 2));
  return envelope.ok ? 0 : 1;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const config = loadConfig(io.env);
  const { command, flags } = parseArgs(argv);
  if (!command || command === "help" || command === "--help") {
    io.stdout(printHelp());
    return command ? 0 : 1;
  }

  const app = await createApp({ config });
  const ctx = invocationContext({
    operationId: createOperationId(),
    tenantId: config.tenantId,
    userId: config.userId,
  });
  try {
    if (command === "accounts") {
      return printEnvelope(io, await app.accounts.list(ctx, {}));
    }
    if (command === "send") {
      const file = flags.get("file")?.[0];
      if (!file) throw new ConfigError("send requires --file <request.json>");
      const body = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return printEnvelope(io, await app.email.send(ctx, body));
    }
    if (command === "append") {
      const file = flags.get("file")?.[0];
      if (!file) throw new ConfigError("append requires --file <request.json>");
      const body = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return printEnvelope(io, await app.docs.append(ctx, body));
    }
    if (command === "auth") {
      assertGoogleClient(config);
      const requested = flags.get("capability") ?? ["gmail.send", "docs.append"];
      const capabilities = requested.filter((value): value is Capability => value === "gmail.send" || value === "docs.append");
      if (capabilities.length !== requested.length) {
        throw new ConfigError("capability must be gmail.send or docs.append");
      }
      let redirectUri = "";
      let exitCode = 0;
      const listener = await listenForCallback({
        port: config.oauthLoopbackPort,
        onCallback: async (query) => {
          const result = await app.oauth.finish(ctx, {
            ...(query.get("code") ? { code: query.get("code") ?? undefined } : {}),
            ...(query.get("state") ? { state: query.get("state") ?? undefined } : {}),
            ...(query.get("error") ? { error: query.get("error") ?? undefined } : {}),
            redirectUri,
          });
          exitCode = result.envelope.ok ? 0 : 1;
          io.stdout(JSON.stringify(result.envelope, null, 2));
          return { status: result.status, html: result.html };
        },
      });
      redirectUri = `http://127.0.0.1:${listener.port}/oauth/google/callback`;
      const begun = await app.accounts.begin(ctx, { capabilities }, redirectUri);
      if (!begun.ok) {
        await listener.close();
        return printEnvelope(io, begun);
      }
      const url = (begun.result as { authorization_url: string }).authorization_url;
      io.stdout(url);
      (io.openUrl ?? openUrl)(url);
      await listener.done;
      return exitCode;
    }
    io.stdout(printHelp());
    return 1;
  } finally {
    await app.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  loadEnvFile();
  runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "Command failed";
      process.stderr.write(`${JSON.stringify({ level: "error", msg: message })}\n`);
      process.exit(1);
    },
  );
}
