import type { AppConfig } from "./env.js";

export type StartupDecision = { action: "serve" } | { action: "exit"; exitCode: number; message: string };

export function decideStartup(config: AppConfig): StartupDecision {
  if (config.nodeEnv === "production" && config.mcpDevBearerSha256) {
    return {
      action: "exit",
      exitCode: 1,
      message: "MCP_DEV_BEARER_SHA256 is refused when NODE_ENV=production. Refusing to open a listen socket.",
    };
  }
  if (config.transport !== "http") return { action: "serve" };
  if (!isHttpUrl(config.publicBaseUrl)) {
    return {
      action: "exit",
      exitCode: 1,
      message: "PUBLIC_BASE_URL is required when TRANSPORT=http. Refusing to open a listen socket.",
    };
  }
  if (!isHttpUrl(config.googleRedirectUri)) {
    return {
      action: "exit",
      exitCode: 1,
      message: "GOOGLE_REDIRECT_URI is required when TRANSPORT=http. Refusing to open a listen socket.",
    };
  }
  if (config.nodeEnv === "production" && !isHttpUrl(config.mcpAuthorizationServer)) {
    return {
      action: "exit",
      exitCode: 1,
      message: "MCP_AUTHORIZATION_SERVER is required when NODE_ENV=production and TRANSPORT=http. Refusing to open a listen socket.",
    };
  }
  if (config.nodeEnv !== "production" && !config.mcpDevBearerSha256 && !isHttpUrl(config.mcpAuthorizationServer)) {
    return {
      action: "exit",
      exitCode: 1,
      message: "Set MCP_DEV_BEARER_SHA256 or MCP_AUTHORIZATION_SERVER before TRANSPORT=http. Refusing to open a listen socket.",
    };
  }
  if (config.tokenStore === "sqlite" && !config.allowSingleReplicaSqlite) {
    return {
      action: "exit",
      exitCode: 1,
      message: "TRANSPORT=http with TOKEN_STORE=sqlite requires ALLOW_SINGLE_REPLICA_SQLITE=true. Refusing to open a listen socket.",
    };
  }
  if (config.tokenStore === "postgres" && !config.tokenStoreDatabaseUrl) {
    return {
      action: "exit",
      exitCode: 1,
      message: "TOKEN_STORE_DATABASE_URL is required when TOKEN_STORE=postgres. Refusing to open a listen socket.",
    };
  }
  return { action: "serve" };
}

function isHttpUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
