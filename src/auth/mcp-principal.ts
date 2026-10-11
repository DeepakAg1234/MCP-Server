import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AppConfig } from "../config/env.js";

export const MCP_CALL_SCOPE = "tools.call";

export type Principal = { tenantId: string; userId: string };

export class McpAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "invalid_token" | "insufficient_scope",
  ) {
    super(status === 401 ? "The bearer token was not accepted." : "The bearer token is missing the tools.call scope.");
  }
}

type DevBearer = { sha256: string; principal: Principal };

const jwksByIssuer = new Map<string, Promise<JWTVerifyGetKey>>();

export function expectedAudience(config: AppConfig): string {
  return config.mcpResourceAudience || config.publicBaseUrl || resourceUrl(config);
}

export function resourceUrl(config: AppConfig): string {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const path = config.mcpPath.startsWith("/") ? config.mcpPath : `/${config.mcpPath}`;
  return `${base}${path}`;
}

export function protectedResourceMetadataPath(mcpPath: string): string {
  const suffix = mcpPath.replace(/^\/+/, "").replace(/\/+$/, "");
  return suffix ? `/.well-known/oauth-protected-resource/${suffix}` : "/.well-known/oauth-protected-resource";
}

export function protectedResourceMetadataUrl(config: AppConfig): string {
  return new URL(protectedResourceMetadataPath(config.mcpPath), config.publicBaseUrl).toString();
}

export function wwwAuthenticate(config: AppConfig, error?: "invalid_token" | "insufficient_scope"): string {
  const parts = [`Bearer realm="mcp"`, `resource_metadata="${protectedResourceMetadataUrl(config)}"`, `scope="${MCP_CALL_SCOPE}"`];
  if (error) parts.splice(1, 0, `error="${error}"`);
  return parts.join(", ");
}

export function devBearers(config: AppConfig): DevBearer[] {
  if (!config.mcpDevBearerSha256) return [];
  const tenantFallback = config.defaultTenantId || config.tenantId;
  const entries: DevBearer[] = [];
  for (const raw of config.mcpDevBearerSha256.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const [sha, second, ...rest] = trimmed.split("|");
    if (!sha) continue;
    const sha256 = sha.toLowerCase();
    if (!second) {
      entries.push({ sha256, principal: { tenantId: tenantFallback, userId: config.userId } });
    } else if (rest.length === 0) {
      entries.push({ sha256, principal: { tenantId: tenantFallback, userId: second } });
    } else {
      entries.push({ sha256, principal: { tenantId: second, userId: rest.join("|") } });
    }
  }
  return entries;
}

export function devBearerHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function authenticateBearer(
  token: string,
  config: AppConfig,
  jwks?: JWTVerifyGetKey,
): Promise<Principal> {
  if (config.nodeEnv !== "production") {
    const digest = devBearerHash(token);
    const match = devBearers(config).find((entry) => entry.sha256 === digest);
    if (match) return match.principal;
  }
  if (!config.mcpAuthorizationServer) throw new McpAuthError(401, "invalid_token");
  const key = jwks ?? (await remoteJwks(config.mcpAuthorizationServer));
  const audience = expectedAudience(config);
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, key, { issuer: config.mcpAuthorizationServer, audience });
    payload = verified.payload;
  } catch {
    throw new McpAuthError(401, "invalid_token");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new McpAuthError(401, "invalid_token");
  if (!scopesOf(payload).includes(MCP_CALL_SCOPE)) throw new McpAuthError(403, "insufficient_scope");
  const claim = payload[config.mcpTenantClaim];
  const tenantId = typeof claim === "string" && claim.length > 0 ? claim : config.defaultTenantId || config.tenantId;
  return { tenantId, userId: payload.sub };
}

function scopesOf(payload: JWTPayload): string[] {
  if (typeof payload.scope === "string") return payload.scope.split(/\s+/).filter((scope) => scope.length > 0);
  if (Array.isArray(payload.scp)) return payload.scp.filter((scope): scope is string => typeof scope === "string");
  return [];
}

async function remoteJwks(issuer: string): Promise<JWTVerifyGetKey> {
  const cached = jwksByIssuer.get(issuer);
  if (cached) return cached;
  const pending = loadRemoteJwks(issuer);
  jwksByIssuer.set(issuer, pending);
  try {
    return await pending;
  } catch (error) {
    jwksByIssuer.delete(issuer);
    throw error;
  }
}

async function loadRemoteJwks(issuer: string): Promise<JWTVerifyGetKey> {
  const root = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const discovery = await fetch(new URL(".well-known/openid-configuration", root));
  if (!discovery.ok) throw new McpAuthError(401, "invalid_token");
  const body = (await discovery.json()) as { issuer?: string; jwks_uri?: string };
  if (body.issuer && body.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
    throw new McpAuthError(401, "invalid_token");
  }
  if (!body.jwks_uri) throw new McpAuthError(401, "invalid_token");
  return createRemoteJWKSet(new URL(body.jwks_uri));
}
