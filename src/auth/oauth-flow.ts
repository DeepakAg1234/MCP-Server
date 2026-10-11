import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AppConfig } from "../config/env.js";
import type { TokenStore } from "../auth/token-store.js";
import type { InvocationContext } from "../domain/context.js";
import { failure, success, type Envelope } from "../domain/envelope.js";
import { ConfigError, GoogleApiError } from "../domain/errors.js";
import { sha256Hex } from "../domain/hash.js";
import { createCodeVerifier, createOAuthState } from "../domain/ids.js";
import { TOOL, scopesForCapabilities, type Capability } from "../domain/tools.js";
import {
  buildAuthorizationUrl,
  codeChallenge,
  decodeIdToken,
  exchangeAuthorizationCode,
  grantedScopes,
} from "../google/oauth-client.js";
import type { AuditWriter } from "../observability/audit.js";
import type { AccessTokenCache } from "./access-token-cache.js";

export type BeginAuthorizationResult = {
  authorization_url: string;
  expires_at: string;
  status: "pending";
};

export type CallbackResult = {
  status: number;
  html: string;
  envelope: Envelope;
};

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>${body}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export class OAuthFlow {
  constructor(
    private readonly config: AppConfig,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch,
    private readonly audit: AuditWriter,
    private readonly clock: () => Date,
    private readonly tokens?: AccessTokenCache,
  ) {}

  async begin(
    ctx: InvocationContext,
    input: { capabilities: Capability[]; accountId?: string; redirectUri: string },
  ): Promise<Envelope<BeginAuthorizationResult>> {
    if (!this.config.googleOauthClientId) {
      throw new ConfigError("GOOGLE_OAUTH_CLIENT_ID is required to authorize a Google account.");
    }
    let existingScopes: string[] = [];
    if (input.accountId) {
      const account = await this.store.getAccount(ctx.tenantId, ctx.userId, input.accountId);
      if (!account) {
        const envelope = failure({
          tool: TOOL.beginAuthorization,
          operationId: ctx.operationId,
          code: "ACCOUNT_NOT_FOUND",
          message: "No Google account is available for this user.",
        });
        this.auditAuth(ctx, envelope, null);
        return envelope;
      }
      existingScopes = account.grantedScopes;
    }
    const scopes = scopesForCapabilities(input.capabilities, existingScopes);
    const state = createOAuthState();
    const verifier = createCodeVerifier();
    const expiresAt = new Date(this.clock().getTime() + this.config.oauthStateTtlSeconds * 1000);
    await this.store.insertOAuthState({
      stateHash: sha256Hex(state),
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      codeVerifier: verifier,
      requestedScopes: scopes,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      expiresAt: expiresAt.toISOString(),
    });
    const authorizationUrl = buildAuthorizationUrl({
      clientId: this.config.googleOauthClientId,
      redirectUri: input.redirectUri,
      scopes,
      state,
      codeChallenge: codeChallenge(verifier),
    });
    const envelope = success(TOOL.beginAuthorization, ctx.operationId, {
      authorization_url: authorizationUrl,
      expires_at: expiresAt.toISOString(),
      status: "pending" as const,
    });
    this.auditAuth(ctx, envelope, input.accountId ?? null);
    return envelope;
  }

  async finish(
    ctx: InvocationContext,
    query: { code?: string; state?: string; error?: string; redirectUri: string },
  ): Promise<CallbackResult> {
    if (!query.state) {
      return this.browserFailure(ctx, "missing", "Authorization failed. Return to the application and try again.");
    }
    if (query.error === "access_denied") {
      const consumed = await this.store.consumeOAuthState({
        stateHash: sha256Hex(query.state),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        now: this.clock().toISOString(),
      });
      if (!consumed.ok && consumed.reason === "principal") {
        return this.browserFailure(ctx, "principal", "Authorization failed. Return to the application and try again.");
      }
      const envelope = failure({
        tool: TOOL.beginAuthorization,
        operationId: ctx.operationId,
        code: "ACCESS_DENIED",
        message: "Google authorization was denied.",
      });
      this.auditAuth(ctx, envelope, null);
      return {
        status: 400,
        html: page("Authorization failed", "Authorization was denied. You can close this window."),
        envelope,
      };
    }
    const consumed = await this.store.consumeOAuthState({
      stateHash: sha256Hex(query.state),
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      now: this.clock().toISOString(),
    });
    if (!consumed.ok) {
      return this.browserFailure(ctx, consumed.reason, "Authorization failed. Return to the application and try again.");
    }
    if (!query.code) {
      return this.browserFailure(ctx, "missing", "Authorization failed. Return to the application and try again.");
    }
    try {
      const token = await exchangeAuthorizationCode({
        fetchImpl: this.fetchImpl,
        config: this.config,
        code: query.code,
        codeVerifier: consumed.codeVerifier,
        redirectUri: query.redirectUri,
        nowMs: this.clock().getTime(),
      });
      if (!token.id_token) {
        throw new GoogleApiError({
          code: "UPSTREAM_ERROR",
          message: "Google did not return an identity token.",
        });
      }
      const identity = decodeIdToken(token.id_token);
      if (!token.refresh_token) {
        const existing = (await this.store.listAccounts(ctx.tenantId, ctx.userId)).find((account) => account.googleSub === identity.sub);
        if (!existing?.hasRefreshToken) {
          throw new GoogleApiError({
            code: "UNAUTHENTICATED",
            message: "Google did not return a refresh token. Authorize again and grant offline access.",
          });
        }
      }
      const scopes = grantedScopes(token, consumed.requestedScopes.split(" "));
      const account = await this.store.upsertConsent({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        googleSub: identity.sub,
        email: identity.email,
        displayName: identity.name,
        grantedScopes: scopes,
        refreshToken: token.refresh_token ?? null,
        now: this.clock().toISOString(),
      });
      if (this.tokens) {
        this.tokens.remember(account.accountId, token.access_token, token.expires_in);
      }
      const envelope = success("oauth_callback", ctx.operationId, {
        account_id: account.accountId,
        email: account.email,
        status: account.status,
      });
      this.auditAuth(ctx, envelope, account.accountId);
      return {
        status: 200,
        html: page("Authorization complete", `Authorization completed for ${escapeHtml(account.email)}.`),
        envelope,
      };
    } catch (error) {
      const api = error instanceof GoogleApiError
        ? error
        : new GoogleApiError({ code: "UPSTREAM_ERROR", message: "Google authorization could not be completed." });
      const envelope = failure({
        tool: TOOL.beginAuthorization,
        operationId: ctx.operationId,
        code: api.code,
        message: api.message,
        retryable: api.retryable,
      });
      this.auditAuth(ctx, envelope, null);
      return {
        status: 400,
        html: page("Authorization failed", "Authorization failed. Return to the application and try again."),
        envelope,
      };
    }
  }

  private browserFailure(ctx: InvocationContext, reason: string, message: string): CallbackResult {
    const envelope = failure({
      tool: TOOL.beginAuthorization,
      operationId: ctx.operationId,
      code: reason === "principal" ? "ACCOUNT_NOT_FOUND" : "INVALID_ARGUMENT",
      message,
    });
    this.auditAuth(ctx, envelope, null);
    return {
      status: 400,
      html: page("Authorization failed", message),
      envelope,
    };
  }

  private auditAuth(ctx: InvocationContext, envelope: Envelope, accountId: string | null): void {
    this.audit.write({
      operation_id: envelope.operation_id,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      account_id: accountId,
      tool: envelope.tool,
      outcome: envelope.ok ? "success" : "error",
      error_code: envelope.ok ? "" : envelope.error.code,
      latency_ms: 0,
      idempotency_replay: false,
      created_at: this.clock().toISOString(),
    });
  }
}

export function listenForCallback(options: {
  port: number | null;
  onCallback: (query: URLSearchParams) => Promise<{ status: number; html: string }>;
}): Promise<{ port: number; close: () => Promise<void>; done: Promise<void> }> {
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveDone();
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const remote = request.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1" && remote !== "::1") {
      response.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/google/callback") {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    void options.onCallback(url.searchParams).then(
      (result) => {
        response.writeHead(result.status, { "content-type": "text/html; charset=utf-8" }).end(result.html);
        server.close(() => finish());
      },
      () => {
        response.writeHead(500, { "content-type": "text/html; charset=utf-8" }).end(
          page("Authorization failed", "Authorization failed. Return to the application and try again."),
        );
        server.close(() => finish());
      },
    );
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("OAuth loopback listener did not bind."));
        return;
      }
      resolve({
        port: address.port,
        done,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => {
              finish();
              closeResolve();
            });
          }),
      });
    });
  });
}
