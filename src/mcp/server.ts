import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, fromJsonSchema, type CallToolResult } from "@modelcontextprotocol/server";
import type { App } from "../app/create-app.js";
import { invocationContext, type TransportName } from "../domain/context.js";
import { failure, type Envelope } from "../domain/envelope.js";
import { createOperationId } from "../domain/ids.js";
import { TOOL, type ToolName } from "../domain/tools.js";
import { validateSchema } from "../tools/validate.js";
import {
  callAppendContent,
  callAuthorizationStatus,
  callBeginAuthorization,
  callListAccounts,
  callSendEmail,
} from "../tools/handlers.js";
import { toolDefinitions } from "../tools/registry.js";
import { envelopeToToolResult } from "./result.js";

const require = createRequire(import.meta.url);
const pkg = require(join(dirname(fileURLToPath(import.meta.url)), "../../package.json")) as { version: string };

const permissiveValidator = {
  getValidator<T>(schema: { $id?: string }) {
    const schemaId = schema.$id;
    return (input: unknown) => {
      if (schemaId?.includes(".output.")) {
        const checked = validateSchema(schemaId, input);
        if (!checked.ok) {
          return { valid: false as const, data: undefined, errorMessage: "Tool result did not match outputSchema." };
        }
      }
      return { valid: true as const, data: input as T, errorMessage: undefined };
    };
  },
};

const HANDLERS: Record<ToolName, (app: App, ctx: ReturnType<typeof invocationContext>, input: unknown) => Promise<Envelope>> = {
  [TOOL.listAccounts]: callListAccounts,
  [TOOL.authorizationStatus]: callAuthorizationStatus,
  [TOOL.beginAuthorization]: callBeginAuthorization,
  [TOOL.sendEmail]: callSendEmail,
  [TOOL.appendContent]: callAppendContent,
};

export function createRegisteredServer(
  app: App,
  principal: { tenantId: string; userId: string },
  transport: TransportName,
): McpServer {
  const server = new McpServer(
    { name: "google-workspace-mcp", version: pkg.version },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const tool of toolDefinitions()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as never, permissiveValidator),
        outputSchema: fromJsonSchema(tool.outputSchema as never, permissiveValidator),
        annotations: tool.annotations,
      },
      async (args: unknown): Promise<CallToolResult> => {
        const ctx = invocationContext({
          operationId: createOperationId(),
          tenantId: principal.tenantId,
          userId: principal.userId,
          transport,
        });
        const started = Date.now();
        try {
          const envelope = await HANDLERS[tool.name](app, ctx, args ?? {});
          const outcome = !envelope.ok
            ? "error"
            : envelope.warnings.some((warning) => warning.code === "IDEMPOTENCY_REPLAY")
              ? "replay"
              : "success";
          app.metrics.increment("mcp_tool_calls_total", {
            tool: tool.name,
            outcome,
            error_code: envelope.ok ? "" : envelope.error.code,
          });
          app.metrics.increment("mcp_tool_duration_seconds", { tool: tool.name }, (Date.now() - started) / 1000);
          return envelopeToToolResult(envelope);
        } catch (error) {
          app.logger.error("tool failed", {
            tool: tool.name,
            error_name: error instanceof Error ? error.name : "Error",
            detail: error instanceof Error ? error.message : "The tool could not be completed.",
          });
          const envelope = failure({
            tool: tool.name,
            operationId: ctx.operationId,
            code: "INTERNAL_ERROR",
            message: "The tool could not be completed.",
          });
          app.metrics.increment("mcp_tool_calls_total", {
            tool: tool.name,
            outcome: "error",
            error_code: "INTERNAL_ERROR",
          });
          app.metrics.increment("mcp_tool_duration_seconds", { tool: tool.name }, (Date.now() - started) / 1000);
          return envelopeToToolResult(envelope);
        }
      },
    );
  }
  return server;
}
