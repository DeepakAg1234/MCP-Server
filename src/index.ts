import "./mcp/stdout-tee.js";
import { pathToFileURL } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createApp } from "./app/create-app.js";
import { loadConfig } from "./config/env.js";
import { loadEnvFile } from "./config/load-env-file.js";
import { decideStartup } from "./config/startup.js";
import { ConfigError } from "./domain/errors.js";
import { startHttpServer } from "./mcp/http.js";
import { createRegisteredServer } from "./mcp/server.js";

export { decideStartup } from "./config/startup.js";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function writeError(message: string): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: "error", msg: message })}\n`);
}

async function main(): Promise<void> {
  try {
    loadEnvFile();
    const config = loadConfig(process.env);
    const decision = decideStartup(config);
    if (decision.action === "exit") {
      writeError(decision.message);
      process.exit(decision.exitCode);
    }
    const app = await createApp({ config });
    if (config.transport === "http") {
      const http = await startHttpServer({ config, app });
      const shutdown = () => {
        void http.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    serveStdio(() => createRegisteredServer(app, { tenantId: config.tenantId, userId: config.userId }, "stdio"));
  } catch (error) {
    const message = error instanceof ConfigError || error instanceof Error ? error.message : "Configuration error";
    writeError(message);
    process.exit(1);
  }
}

if (isDirectRun()) {
  void main();
}
