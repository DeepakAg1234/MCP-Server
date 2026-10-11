import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL, TOOL_ORDER, type ToolName } from "../domain/tools.js";
import { schemaDirectory } from "./validate.js";

const schemaDir = schemaDirectory();

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type ToolDefinition = {
  name: ToolName;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

const DESCRIPTIONS: Record<ToolName, string> = {
  [TOOL.listAccounts]:
    "Lists Google accounts already authorized for this local user, with display email and granted scopes.",
  [TOOL.authorizationStatus]:
    "Reports whether the selected account currently has the scopes a capability needs.",
  [TOOL.beginAuthorization]:
    "Starts a Google authorization and returns an authorization URL for the user to open. The tool does not wait for consent and does not return tokens.",
  [TOOL.sendEmail]:
    "Sends one email through the selected Gmail account. Acceptance by Gmail does not guarantee that a recipient's mailbox accepted the message. Follow the host client's confirmation policy before calling this tool.",
  [TOOL.appendContent]:
    "Appends plain text at the end of an existing Google Doc and does not read the document body back to the caller. Follow the host client's confirmation policy before calling this tool.",
};

const ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  [TOOL.listAccounts]: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  [TOOL.authorizationStatus]: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  [TOOL.beginAuthorization]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  [TOOL.sendEmail]: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  [TOOL.appendContent]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const SCHEMA_FILES: Record<ToolName, string> = {
  [TOOL.listAccounts]: "google_list_accounts.schema.json",
  [TOOL.authorizationStatus]: "google_authorization_status.schema.json",
  [TOOL.beginAuthorization]: "google_begin_authorization.schema.json",
  [TOOL.sendEmail]: "gmail_send_email.schema.json",
  [TOOL.appendContent]: "gdocs_append_content.schema.json",
};

function loadSchema(name: ToolName): { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> } {
  const schema = JSON.parse(readFileSync(join(schemaDir, SCHEMA_FILES[name]), "utf8")) as {
    $defs?: { output?: Record<string, unknown> };
  };
  const outputSchema = schema.$defs?.output;
  if (!outputSchema) throw new Error(`Missing output schema for ${name}`);
  return { inputSchema: schema, outputSchema };
}

export function toolDefinitions(): ToolDefinition[] {
  return TOOL_ORDER.map((name) => {
    const schemas = loadSchema(name);
    return {
      name,
      description: DESCRIPTIONS[name],
      annotations: ANNOTATIONS[name],
      inputSchema: schemas.inputSchema,
      outputSchema: schemas.outputSchema,
    };
  });
}
