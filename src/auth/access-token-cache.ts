import type { AppConfig } from "../config/env.js";
import { GoogleApiError } from "../domain/errors.js";
import type { AccountRecord, TokenStore } from "../auth/token-store.js";
import type { InvocationContext } from "../domain/context.js";
import { refreshAccessToken } from "../google/oauth-client.js";
import type { Metrics } from "../observability/metrics.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger } from "../observability/logger.js";

type CacheEntry = {
  token: string;
  expiresAtMs: number;
};

export class AccessTokenCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch,
    private readonly config: Pick<AppConfig, "googleOauthClientId" | "googleOauthClientSecret">,
    private readonly clock: () => Date,
    private readonly metrics: Metrics = noopMetrics,
    private readonly logger?: Pick<Logger, "addSecret">,
  ) {}

  drop(accountId: string): void {
    this.entries.delete(accountId);
  }

  remember(accountId: string, accessToken: string, expiresInSeconds: number): void {
    this.logger?.addSecret(accessToken);
    const now = this.clock().getTime();
    const lifetimeMs = Math.max(0, expiresInSeconds * 1000 - 60_000);
    this.entries.set(accountId, {
      token: accessToken,
      expiresAtMs: now + Math.min(lifetimeMs, 50 * 60 * 1000),
    });
  }

  async getAccessToken(ctx: InvocationContext, account: AccountRecord): Promise<string> {
    const now = this.clock().getTime();
    const cached = this.entries.get(account.accountId);
    if (cached && cached.expiresAtMs > now) return cached.token;

    const refreshToken = await this.store.readRefreshToken(ctx.tenantId, ctx.userId, account.accountId);
    if (refreshToken) this.logger?.addSecret(refreshToken);
    if (!refreshToken) {
      throw new GoogleApiError({
        code: "UNAUTHENTICATED",
        message: "The Google account must be authorized again.",
      });
    }

    try {
      const token = await refreshAccessToken({
        fetchImpl: this.fetchImpl,
        config: this.config,
        refreshToken,
        nowMs: now,
      });
      if (token.refresh_token) {
        this.logger?.addSecret(token.refresh_token);
        await this.store.saveRefreshToken(ctx.tenantId, ctx.userId, account.accountId, token.refresh_token, this.clock().toISOString());
      }
      this.logger?.addSecret(token.access_token);
      this.metrics.increment("oauth_refresh_total", { result: "success" });
      const lifetimeMs = Math.max(0, token.expires_in * 1000 - 60_000);
      const expiresAtMs = now + Math.min(lifetimeMs, 50 * 60 * 1000);
      this.entries.set(account.accountId, { token: token.access_token, expiresAtMs });
      return token.access_token;
    } catch (error) {
      const invalidGrant = error instanceof GoogleApiError && error.code === "UNAUTHENTICATED";
      this.metrics.increment("oauth_refresh_total", { result: invalidGrant ? "invalid_grant" : "error" });
      if (error instanceof GoogleApiError) {
        this.metrics.increment("google_api_errors_total", { api: "oauth", error_code: error.code });
      }
      if (invalidGrant) {
        await this.store.markReauthorizationRequired(ctx.tenantId, ctx.userId, account.accountId, this.clock().toISOString());
        this.drop(account.accountId);
      }
      throw error;
    }
  }
}
