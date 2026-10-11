import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Envelope } from "../domain/envelope.js";

export function envelopeToToolResult(envelope: Envelope): CallToolResult {
  const text = JSON.stringify(envelope);
  return {
    content: [{ type: "text", text }],
    structuredContent: envelope as Record<string, unknown>,
    isError: !envelope.ok,
  };
}
