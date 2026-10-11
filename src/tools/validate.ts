import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { AppConfig } from "../config/env.js";
import type { Capability, StatusCapability } from "../domain/tools.js";
import { domainOf, parseAddressList } from "../google/address.js";
import { parseDocumentId } from "../google/document-id.js";

export type SchemaFile = {
  name: string;
  schema: Record<string, unknown>;
};

export function schemaDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const adjacent = join(here, "schemas");
  if (existsSync(adjacent)) return adjacent;
  return join(here, "../../schemas");
}

const schemaDir = schemaDirectory();

function loadSchemaFiles(): SchemaFile[] {
  return readdirSync(schemaDir)
    .filter((name) => name.endsWith(".schema.json"))
    .sort()
    .map((name) => ({
      name,
      schema: JSON.parse(readFileSync(join(schemaDir, name), "utf8")) as Record<string, unknown>,
    }));
}

export function listSchemaFiles(): SchemaFile[] {
  return loadSchemaFiles();
}

type Compiled = {
  ajv: Ajv2020;
  validators: Map<string, ValidateFunction>;
};

let compiled: Compiled | undefined;

function compile(): Compiled {
  if (compiled) return compiled;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validators = new Map<string, ValidateFunction>();
  for (const file of loadSchemaFiles()) {
    ajv.addSchema(file.schema);
  }
  const ids = [
    "https://google-workspace-mcp.local/schemas/error.json",
    "https://google-workspace-mcp.local/schemas/envelope.json",
    "https://google-workspace-mcp.local/schemas/google_list_accounts.json",
    "https://google-workspace-mcp.local/schemas/google_list_accounts.output.json",
    "https://google-workspace-mcp.local/schemas/google_authorization_status.json",
    "https://google-workspace-mcp.local/schemas/google_authorization_status.output.json",
    "https://google-workspace-mcp.local/schemas/google_begin_authorization.json",
    "https://google-workspace-mcp.local/schemas/google_begin_authorization.output.json",
    "https://google-workspace-mcp.local/schemas/gmail_send_email.json",
    "https://google-workspace-mcp.local/schemas/gmail_send_email.output.json",
    "https://google-workspace-mcp.local/schemas/gdocs_append_content.json",
    "https://google-workspace-mcp.local/schemas/gdocs_append_content.output.json",
  ];
  for (const id of ids) {
    const validate = ajv.getSchema(id);
    if (!validate) {
      throw new Error(`JSON Schema was not registered: ${id}`);
    }
    validators.set(id, validate);
  }
  compiled = { ajv, validators };
  return compiled;
}

export function validateSchema(schemaId: string, value: unknown): { ok: true } | { ok: false; message: string } {
  const validate = compile().validators.get(schemaId);
  if (!validate) return { ok: false, message: `Unknown schema ${schemaId}` };
  if (validate(value)) return { ok: true };
  return { ok: false, message: formatErrors(validate.errors) };
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "Request does not match the tool schema.";
  const attachment = errors.find((error) => error.instancePath === "/attachments" || error.schemaPath.includes("attachments"));
  if (attachment) {
    return "attachments are not supported. Remove the attachments field.";
  }
  return errors
    .map((error) => {
      const path = error.instancePath || "request";
      if (error.keyword === "additionalProperties") {
        const extra = (error.params as { additionalProperty?: string }).additionalProperty;
        return `Unknown field ${extra ?? path}`;
      }
      if (error.keyword === "required") {
        return `Missing ${(error.params as { missingProperty?: string }).missingProperty ?? "field"}`;
      }
      return `${path} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

export type GmailSendInput = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyFormat: "plain" | "html";
  accountId?: string;
  replyToMessageId?: string;
  idempotencyKey?: string;
};

export type DocsAppendInput = {
  documentId: string;
  canonicalDocumentId: string;
  content: string;
  format: "plain_text";
  prependNewline: boolean;
  accountId?: string;
  idempotencyKey?: string;
};

export type ListAccountsInput = Record<string, never>;

export type AuthorizationStatusInput = {
  accountId?: string;
  capability: StatusCapability;
};

export type BeginAuthorizationInput = {
  accountId?: string;
  capabilities: Capability[];
};

const GMAIL_INPUT = "https://google-workspace-mcp.local/schemas/gmail_send_email.json";
const DOCS_INPUT = "https://google-workspace-mcp.local/schemas/gdocs_append_content.json";
const LIST_INPUT = "https://google-workspace-mcp.local/schemas/google_list_accounts.json";
const STATUS_INPUT = "https://google-workspace-mcp.local/schemas/google_authorization_status.json";
const BEGIN_INPUT = "https://google-workspace-mcp.local/schemas/google_begin_authorization.json";

export function parseGmailSendInput(
  value: unknown,
  config: Pick<AppConfig, "allowMissingTo" | "maxRecipients" | "maxSubjectChars" | "maxBodyBytes">,
): { ok: true; value: GmailSendInput } | { ok: false; message: string } {
  const schema = validateSchema(GMAIL_INPUT, value);
  if (!schema.ok) return schema;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "attachments")) {
    return { ok: false, message: "attachments are not supported. Remove the attachments field." };
  }
  const to = (record.to as string[] | undefined) ?? [];
  const cc = (record.cc as string[] | undefined) ?? [];
  const bcc = (record.bcc as string[] | undefined) ?? [];
  if (!config.allowMissingTo && to.length === 0) {
    return { ok: false, message: "to must contain at least one address" };
  }
  if (to.length + cc.length + bcc.length === 0) {
    return { ok: false, message: "at least one recipient is required across to, cc, and bcc" };
  }
  if (to.length + cc.length + bcc.length > config.maxRecipients) {
    return { ok: false, message: `recipient count exceeds MAX_RECIPIENTS (${config.maxRecipients})` };
  }
  const addresses = parseAddressList([...to, ...cc, ...bcc]);
  if (!addresses.ok) return addresses;
  const subject = record.subject as string;
  if (subject.length > config.maxSubjectChars) {
    return { ok: false, message: `subject exceeds MAX_SUBJECT_CHARS (${config.maxSubjectChars})` };
  }
  const body = record.body as string;
  if (Buffer.byteLength(body, "utf8") > config.maxBodyBytes) {
    return { ok: false, message: `body exceeds MAX_BODY_BYTES (${config.maxBodyBytes})` };
  }
  const parsed: GmailSendInput = {
    to,
    cc,
    bcc,
    subject,
    body,
    bodyFormat: (record.body_format as "plain" | "html" | undefined) ?? "plain",
  };
  if (typeof record.account_id === "string") parsed.accountId = record.account_id;
  if (typeof record.reply_to_message_id === "string") parsed.replyToMessageId = record.reply_to_message_id;
  if (typeof record.idempotency_key === "string") parsed.idempotencyKey = record.idempotency_key;
  return { ok: true, value: parsed };
}

export function parseDocsAppendInput(
  value: unknown,
  config: Pick<AppConfig, "maxDocContentBytes">,
): { ok: true; value: DocsAppendInput } | { ok: false; message: string } {
  const schema = validateSchema(DOCS_INPUT, value);
  if (!schema.ok) return schema;
  const record = value as Record<string, unknown>;
  const document = parseDocumentId(record.document_id as string);
  if (!document.ok) return document;
  const content = record.content as string;
  if (Buffer.byteLength(content, "utf8") > config.maxDocContentBytes) {
    return { ok: false, message: `content exceeds MAX_DOC_CONTENT_BYTES (${config.maxDocContentBytes})` };
  }
  const parsed: DocsAppendInput = {
    documentId: record.document_id as string,
    canonicalDocumentId: document.documentId,
    content,
    format: "plain_text",
    prependNewline: (record.prepend_newline as boolean | undefined) ?? true,
  };
  if (typeof record.account_id === "string") parsed.accountId = record.account_id;
  if (typeof record.idempotency_key === "string") parsed.idempotencyKey = record.idempotency_key;
  return { ok: true, value: parsed };
}

export function parseListAccountsInput(value: unknown): { ok: true; value: ListAccountsInput } | { ok: false; message: string } {
  const schema = validateSchema(LIST_INPUT, value);
  if (!schema.ok) return schema;
  return { ok: true, value: {} };
}

export function parseAuthorizationStatusInput(
  value: unknown,
): { ok: true; value: AuthorizationStatusInput } | { ok: false; message: string } {
  const schema = validateSchema(STATUS_INPUT, value);
  if (!schema.ok) return schema;
  const record = value as Record<string, unknown>;
  const parsed: AuthorizationStatusInput = { capability: record.capability as StatusCapability };
  if (typeof record.account_id === "string") parsed.accountId = record.account_id;
  return { ok: true, value: parsed };
}

export function parseBeginAuthorizationInput(
  value: unknown,
): { ok: true; value: BeginAuthorizationInput } | { ok: false; message: string } {
  const schema = validateSchema(BEGIN_INPUT, value);
  if (!schema.ok) return schema;
  const record = value as Record<string, unknown>;
  const parsed: BeginAuthorizationInput = { capabilities: record.capabilities as Capability[] };
  if (typeof record.account_id === "string") parsed.accountId = record.account_id;
  return { ok: true, value: parsed };
}

export function recipientDomains(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map((address) => domainOf(address)))];
}
