import { ConfigError } from "../domain/errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type TransportSetting = "stdio" | "http";
export type TokenStoreKind = "sqlite" | "postgres";

export type AppConfig = {
  transport: TransportSetting;
  host: string;
  port: number;
  mcpPath: string;
  publicBaseUrl: string;
  tenantId: string;
  userId: string;
  mcpAuthorizationServer: string;
  mcpResourceAudience: string;
  mcpTenantClaim: string;
  mcpDevBearerSha256: string;
  nodeEnv: string;
  googleOauthClientId: string;
  googleOauthClientSecret: string;
  googleRedirectUri: string;
  oauthLoopbackPort: number | null;
  oauthStateTtlSeconds: number;
  tokenStore: TokenStoreKind;
  tokenStoreSqlitePath: string;
  tokenStoreDatabaseUrl: string;
  tokenEncryptionKey: string;
  tokenEncryptionKeyRef: string;
  defaultAccountId: string;
  allowMissingTo: boolean;
  logLevel: LogLevel;
  logContent: boolean;
  auditRetentionDays: number;
  auditRecipientDomains: boolean;
  auditIncludeRecipients: boolean;
  maxRecipients: number;
  maxSubjectChars: number;
  maxBodyBytes: number;
  maxDocContentBytes: number;
  maxConcurrencyPerAccount: number;
  rateLimitPerAccountPerMinute: number;
  rateLimitPerPrincipalPerMinute: number;
  docsAppendMaxAttempts: number;
  upstreamMaxAttempts: number;
  idempotencyTtlHours: number;
  idempotencyLeaseSeconds: number;
  allowAccountIds: string[];
  allowRecipientDomains: string[];
  allowBccDomains: string[];
  allowDocumentIds: string[];
  metricsEnabled: boolean;
  metricsToken: string;
  allowSingleReplicaSqlite: boolean;
  defaultTenantId: string;
};

export const ENV_NAMES = [
  "TRANSPORT",
  "HOST",
  "PORT",
  "MCP_PATH",
  "PUBLIC_BASE_URL",
  "TENANT_ID",
  "USER_ID",
  "MCP_AUTHORIZATION_SERVER",
  "MCP_RESOURCE_AUDIENCE",
  "MCP_TENANT_CLAIM",
  "MCP_DEV_BEARER_SHA256",
  "NODE_ENV",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "OAUTH_LOOPBACK_PORT",
  "OAUTH_STATE_TTL_SECONDS",
  "TOKEN_STORE",
  "TOKEN_STORE_SQLITE_PATH",
  "TOKEN_STORE_DATABASE_URL",
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_ENCRYPTION_KEY_REF",
  "DEFAULT_ACCOUNT_ID",
  "ALLOW_MISSING_TO",
  "LOG_LEVEL",
  "LOG_CONTENT",
  "AUDIT_RETENTION_DAYS",
  "AUDIT_RECIPIENT_DOMAINS",
  "AUDIT_INCLUDE_RECIPIENTS",
  "MAX_RECIPIENTS",
  "MAX_SUBJECT_CHARS",
  "MAX_BODY_BYTES",
  "MAX_DOC_CONTENT_BYTES",
  "MAX_CONCURRENCY_PER_ACCOUNT",
  "RATE_LIMIT_PER_ACCOUNT_PER_MINUTE",
  "RATE_LIMIT_PER_PRINCIPAL_PER_MINUTE",
  "DOCS_APPEND_MAX_ATTEMPTS",
  "UPSTREAM_MAX_ATTEMPTS",
  "IDEMPOTENCY_TTL_HOURS",
  "IDEMPOTENCY_LEASE_SECONDS",
  "ALLOW_ACCOUNT_IDS",
  "ALLOW_RECIPIENT_DOMAINS",
  "ALLOW_BCC_DOMAINS",
  "ALLOW_DOCUMENT_IDS",
  "METRICS_ENABLED",
  "METRICS_TOKEN",
  "ALLOW_SINGLE_REPLICA_SQLITE",
  "DEFAULT_TENANT_ID",
] as const;

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stringValue(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return read(env, name) ?? fallback;
}

function integerValue(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer`);
  }
  const parsed = Number(raw);
  if (parsed < min) {
    throw new ConfigError(`${name} must be at least ${min}`);
  }
  return parsed;
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(`${name} must be true or false`);
}

function enumValue<T extends string>(env: NodeJS.ProcessEnv, name: string, fallback: T, allowed: readonly T[]): T {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ConfigError(`${name} must be one of ${allowed.join(", ")}`);
}

function listValue(env: NodeJS.ProcessEnv, name: string, lower = false): string[] {
  const raw = read(env, name);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (lower ? part.toLowerCase() : part));
}

function onRailway(env: NodeJS.ProcessEnv): boolean {
  return read(env, "RAILWAY_ENVIRONMENT") !== undefined || read(env, "RAILWAY_PROJECT_ID") !== undefined;
}

function railwayPublicOrigin(env: NodeJS.ProcessEnv): string {
  const domain = read(env, "RAILWAY_PUBLIC_DOMAIN");
  if (!domain) return "";
  if (/^https?:\/\//i.test(domain)) return domain.replace(/\/$/, "");
  return `https://${domain}`;
}

function isHttpOrigin(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const railway = onRailway(env);
  const publicBaseUrl = stringValue(env, "PUBLIC_BASE_URL", railway ? railwayPublicOrigin(env) : "");
  const redirectFallback =
    railway && isHttpOrigin(publicBaseUrl) ? `${publicBaseUrl.replace(/\/$/, "")}/oauth/google/callback` : "";
  const databaseUrl = stringValue(env, "TOKEN_STORE_DATABASE_URL", railway ? stringValue(env, "DATABASE_URL", "") : "");
  const tokenStore = read(env, "TOKEN_STORE")
    ? enumValue(env, "TOKEN_STORE", "sqlite", ["sqlite", "postgres"] as const)
    : railway && databaseUrl
      ? "postgres"
      : "sqlite";
  const oauthLoopbackRaw = read(env, "OAUTH_LOOPBACK_PORT");
  let oauthLoopbackPort: number | null = null;
  if (oauthLoopbackRaw !== undefined) {
    if (!/^\d+$/.test(oauthLoopbackRaw)) {
      throw new ConfigError("OAUTH_LOOPBACK_PORT must be an integer");
    }
    oauthLoopbackPort = Number(oauthLoopbackRaw);
    if (oauthLoopbackPort < 1 || oauthLoopbackPort > 65535) {
      throw new ConfigError("OAUTH_LOOPBACK_PORT must be between 1 and 65535");
    }
  }

  return {
    transport: enumValue(env, "TRANSPORT", railway ? "http" : "stdio", ["stdio", "http"] as const),
    host: stringValue(env, "HOST", railway ? "::" : "127.0.0.1"),
    port: integerValue(env, "PORT", 8080, 1),
    mcpPath: stringValue(env, "MCP_PATH", "/mcp"),
    publicBaseUrl,
    tenantId: stringValue(env, "TENANT_ID", "local"),
    userId: stringValue(env, "USER_ID", "local"),
    mcpAuthorizationServer: stringValue(env, "MCP_AUTHORIZATION_SERVER", ""),
    mcpResourceAudience: stringValue(env, "MCP_RESOURCE_AUDIENCE", publicBaseUrl),
    mcpTenantClaim: stringValue(env, "MCP_TENANT_CLAIM", "tenant_id"),
    mcpDevBearerSha256: stringValue(env, "MCP_DEV_BEARER_SHA256", ""),
    nodeEnv: stringValue(env, "NODE_ENV", "development"),
    googleOauthClientId: stringValue(env, "GOOGLE_OAUTH_CLIENT_ID", ""),
    googleOauthClientSecret: stringValue(env, "GOOGLE_OAUTH_CLIENT_SECRET", ""),
    googleRedirectUri: stringValue(env, "GOOGLE_REDIRECT_URI", redirectFallback),
    oauthLoopbackPort,
    oauthStateTtlSeconds: integerValue(env, "OAUTH_STATE_TTL_SECONDS", 600, 1),
    tokenStore,
    tokenStoreSqlitePath: stringValue(env, "TOKEN_STORE_SQLITE_PATH", "./data/tokens.sqlite"),
    tokenStoreDatabaseUrl: databaseUrl,
    tokenEncryptionKey: stringValue(env, "TOKEN_ENCRYPTION_KEY", ""),
    tokenEncryptionKeyRef: stringValue(env, "TOKEN_ENCRYPTION_KEY_REF", ""),
    defaultAccountId: stringValue(env, "DEFAULT_ACCOUNT_ID", ""),
    allowMissingTo: booleanValue(env, "ALLOW_MISSING_TO", false),
    logLevel: enumValue(env, "LOG_LEVEL", "info", ["debug", "info", "warn", "error"] as const),
    logContent: booleanValue(env, "LOG_CONTENT", false),
    auditRetentionDays: integerValue(env, "AUDIT_RETENTION_DAYS", 30, 1),
    auditRecipientDomains: booleanValue(env, "AUDIT_RECIPIENT_DOMAINS", true),
    auditIncludeRecipients: booleanValue(env, "AUDIT_INCLUDE_RECIPIENTS", false),
    maxRecipients: integerValue(env, "MAX_RECIPIENTS", 50, 1),
    maxSubjectChars: integerValue(env, "MAX_SUBJECT_CHARS", 998, 1),
    maxBodyBytes: integerValue(env, "MAX_BODY_BYTES", 262144, 1),
    maxDocContentBytes: integerValue(env, "MAX_DOC_CONTENT_BYTES", 262144, 1),
    maxConcurrencyPerAccount: integerValue(env, "MAX_CONCURRENCY_PER_ACCOUNT", 2, 1),
    rateLimitPerAccountPerMinute: integerValue(env, "RATE_LIMIT_PER_ACCOUNT_PER_MINUTE", 20, 1),
    rateLimitPerPrincipalPerMinute: integerValue(env, "RATE_LIMIT_PER_PRINCIPAL_PER_MINUTE", 60, 1),
    docsAppendMaxAttempts: integerValue(env, "DOCS_APPEND_MAX_ATTEMPTS", 3, 1),
    upstreamMaxAttempts: integerValue(env, "UPSTREAM_MAX_ATTEMPTS", 2, 0),
    idempotencyTtlHours: integerValue(env, "IDEMPOTENCY_TTL_HOURS", 24, 1),
    idempotencyLeaseSeconds: integerValue(env, "IDEMPOTENCY_LEASE_SECONDS", 120, 1),
    allowAccountIds: listValue(env, "ALLOW_ACCOUNT_IDS"),
    allowRecipientDomains: listValue(env, "ALLOW_RECIPIENT_DOMAINS", true),
    allowBccDomains: listValue(env, "ALLOW_BCC_DOMAINS", true),
    allowDocumentIds: listValue(env, "ALLOW_DOCUMENT_IDS"),
    metricsEnabled: booleanValue(env, "METRICS_ENABLED", false),
    metricsToken: stringValue(env, "METRICS_TOKEN", ""),
    allowSingleReplicaSqlite: booleanValue(env, "ALLOW_SINGLE_REPLICA_SQLITE", false),
    defaultTenantId: stringValue(env, "DEFAULT_TENANT_ID", ""),
  };
}

export function assertEncryptionKey(config: AppConfig): void {
  if (config.tokenEncryptionKey) return;
  if (config.tokenEncryptionKeyRef) {
    throw new ConfigError(
      "TOKEN_ENCRYPTION_KEY_REF is not supported in this build. Set TOKEN_ENCRYPTION_KEY to 32 bytes of base64.",
    );
  }
  throw new ConfigError("TOKEN_ENCRYPTION_KEY is required before opening the token store.");
}

export function assertGoogleClient(config: AppConfig): void {
  if (!config.googleOauthClientId) {
    throw new ConfigError("GOOGLE_OAUTH_CLIENT_ID is required to authorize a Google account.");
  }
}
