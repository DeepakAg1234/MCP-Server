import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { JWTVerifyGetKey } from "jose";
import type { App } from "../app/create-app.js";
import { createApp } from "../app/create-app.js";
import type { AppConfig } from "../config/env.js";
import { invocationContext } from "../domain/context.js";
import { sha256Hex } from "../domain/hash.js";
import { createOperationId } from "../domain/ids.js";
import { metricsAccess } from "../observability/metrics.js";
import {
  authenticateBearer,
  MCP_CALL_SCOPE,
  McpAuthError,
  expectedAudience,
  protectedResourceMetadataPath,
  protectedResourceMetadataUrl,
  wwwAuthenticate,
  type Principal,
} from "../auth/mcp-principal.js";
import { createRegisteredServer } from "./server.js";

export type HttpServer = {
  baseUrl: string;
  app: App;
  close: () => Promise<void>;
};

function listenUrl(host: string, port: number): string {
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `http://${formatted}:${port}`;
}

export async function startHttpServer(options: {
  config: AppConfig;
  app?: App;
  fetchImpl?: typeof fetch;
  jwks?: JWTVerifyGetKey;
}): Promise<HttpServer> {
  const app = options.app ?? (await createApp({ config: options.config, fetchImpl: options.fetchImpl }));
  const mcp = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra;
      const tenantId = typeof extra?.tenantId === "string" ? extra.tenantId : "";
      const userId = typeof extra?.userId === "string" ? extra.userId : "";
      if (!tenantId || !userId) throw new Error("MCP principal is missing.");
      return createRegisteredServer(app, { tenantId, userId }, "streamable-http");
    },
    {
      maxRequestBodySize: Math.max(options.config.maxBodyBytes, options.config.maxDocContentBytes) + 65_536,
    },
  );
  const server = createServer((request, response) => {
    void handleNodeRequest(app, mcp, options.jwks, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.port, options.config.host, () => resolve());
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : options.config.port;
  app.logger.info("http listening", { host: options.config.host, port, mcp_path: options.config.mcpPath });
  return {
    baseUrl: listenUrl(options.config.host, port),
    app,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          void app.close().then(() => resolve());
        });
      }),
  };
}

async function handleNodeRequest(
  app: App,
  mcp: ReturnType<typeof createMcpHandler>,
  jwks: JWTVerifyGetKey | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(request);
    const host = request.headers.host ?? `${app.config.host}:${app.config.port}`;
    const url = new URL(request.url ?? "/", `http://${host}`);
    const web = new Request(url, {
      method: request.method,
      headers: headersFrom(request),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    });
    const result = await routeHttp(app, mcp, jwks, web, request.socket.remoteAddress);
    await writeResponse(response, result);
  } catch (error) {
    app.logger.error("http request failed", {
      detail: error instanceof Error ? error.message : "The HTTP request failed.",
    });
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ status: "unavailable" }));
    }
  }
}

export async function routeHttp(
  app: App,
  mcp: ReturnType<typeof createMcpHandler>,
  jwks: JWTVerifyGetKey | undefined,
  request: Request,
  remoteAddress: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/healthz") {
    return json(200, { status: "ok" });
  }
  if (request.method === "GET" && path === "/readyz") {
    try {
      await app.store.ping();
      return json(200, { status: "ok" });
    } catch {
      return json(503, { status: "unavailable" });
    }
  }
  if (request.method === "GET" && path === "/metrics") {
    return metricsResponse(app, remoteAddress, request.headers.get("authorization"));
  }
  if (request.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === protectedResourceMetadataPath(app.config.mcpPath))) {
    return json(200, protectedResourceDocument(app.config));
  }
  if (request.method === "GET" && path === "/oauth/google/callback") {
    return googleCallback(app, request, jwks);
  }
  if (path === normalizePath(app.config.mcpPath)) {
    return mcpRequest(app, mcp, jwks, request);
  }
  return json(404, { status: "unavailable" });
}

async function mcpRequest(
  app: App,
  mcp: ReturnType<typeof createMcpHandler>,
  jwks: JWTVerifyGetKey | undefined,
  request: Request,
): Promise<Response> {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (!match?.[1]) return challenge(app.config, new McpAuthError(401, "invalid_token"));
  try {
    const principal = await authenticateBearer(match[1], app.config, jwks);
    const authInfo: AuthInfo = {
      token: match[1],
      clientId: app.config.nodeEnv === "production" ? "mcp" : "development",
      scopes: [MCP_CALL_SCOPE],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { tenantId: principal.tenantId, userId: principal.userId },
    };
    return mcp.fetch(request, { authInfo });
  } catch (error) {
    if (error instanceof McpAuthError) return challenge(app.config, error);
    throw error;
  }
}

async function googleCallback(app: App, request: Request, jwks: JWTVerifyGetKey | undefined): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const owner = state ? await app.store.findOAuthStateOwner(sha256Hex(state)) : null;
  let presented: Principal | null = null;
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) return challenge(app.config, new McpAuthError(401, "invalid_token"));
    try {
      presented = await authenticateBearer(match[1], app.config, jwks);
    } catch (error) {
      if (error instanceof McpAuthError) return challenge(app.config, error);
      throw error;
    }
  }
  if (!owner || (presented && (presented.tenantId !== owner.tenantId || presented.userId !== owner.userId))) {
    return html(400, "Authorization failed. Return to the application and try again.");
  }
  const ctx = invocationContext({
    operationId: createOperationId(),
    tenantId: owner.tenantId,
    userId: owner.userId,
    transport: "streamable-http",
  });
  const result = await app.oauth.finish(ctx, {
    ...(url.searchParams.get("code") ? { code: url.searchParams.get("code") ?? undefined } : {}),
    ...(state ? { state } : {}),
    ...(url.searchParams.get("error") ? { error: url.searchParams.get("error") ?? undefined } : {}),
    redirectUri: app.config.googleRedirectUri,
  });
  return html(result.status, result.html, true);
}

function metricsResponse(app: App, remoteAddress: string | undefined, authorization: string | null): Response {
  if (!app.config.metricsEnabled) return json(404, { status: "unavailable" });
  const access = metricsAccess({
    remoteAddress,
    metricsToken: app.config.metricsToken,
    authorization: authorization ?? undefined,
  });
  if (access === "forbidden") return json(403, { status: "unavailable" });
  if (access === "unauthorized") return json(401, { status: "unavailable" });
  return new Response(app.metrics.renderPrometheus(), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

function protectedResourceDocument(config: AppConfig): Record<string, unknown> {
  return {
    resource: expectedAudience(config),
    authorization_servers: config.mcpAuthorizationServer ? [config.mcpAuthorizationServer] : [],
    scopes_supported: [MCP_CALL_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "google-workspace-mcp",
  };
}

function challenge(config: AppConfig, error: McpAuthError): Response {
  return new Response(JSON.stringify({ error: error.code }), {
    status: error.status,
    headers: {
      "content-type": "application/json",
      "www-authenticate": wwwAuthenticate(config, error.code),
      "cache-control": "no-store",
    },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function html(status: number, body: string, raw = false): Response {
  const page = raw
    ? body
    : `<!doctype html><html><head><meta charset="utf-8"><title>Authorization failed</title></head><body><p>${body}</p></body></html>`;
  return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) return `/${path}`;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function headersFrom(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  const headers = new Headers(result.headers);
  response.writeHead(result.status, Object.fromEntries(headers.entries()));
  const bytes = Buffer.from(await result.arrayBuffer());
  response.end(bytes);
}

export { protectedResourceMetadataUrl };
