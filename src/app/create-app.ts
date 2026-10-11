import { assertEncryptionKey, type AppConfig } from "../config/env.js";
import { ConfigError } from "../domain/errors.js";
import { AccessTokenCache } from "../auth/access-token-cache.js";
import { encryptionKeyFromBase64, TokenCipher } from "../auth/cipher.js";
import { OAuthFlow } from "../auth/oauth-flow.js";
import { createPgSql } from "../auth/pg-db.js";
import { PostgresTokenStore } from "../auth/postgres-token-store.js";
import { SqliteTokenStore } from "../auth/sqlite-token-store.js";
import type { TokenStore } from "../auth/token-store.js";
import { DocsClient } from "../google/docs-client.js";
import { GmailClient } from "../google/gmail-client.js";
import { type AuditWriter } from "../observability/audit.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { loggingMetrics, type Metrics } from "../observability/metrics.js";
import { SqliteAuditWriter } from "../observability/sqlite-audit.js";
import { EnvAllowlistPolicy } from "../policy/allowlist.js";
import { type PolicyEngine } from "../policy/engine.js";
import { InProcessRateLimiter } from "../policy/in-process-rate-limiter.js";
import { type RateLimiter } from "../policy/rate-limiter.js";
import { AccountService } from "../services/account-service.js";
import { DocsService } from "../services/docs-service.js";
import { EmailService } from "../services/email-service.js";
import { IdempotencyService } from "../services/idempotency-service.js";

export type App = {
  config: AppConfig;
  store: TokenStore;
  oauth: OAuthFlow;
  accounts: AccountService;
  email: EmailService;
  docs: DocsService;
  audit: AuditWriter;
  logger: Logger;
  metrics: Metrics;
  close: () => Promise<void>;
};

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function createApp(options: {
  config: AppConfig;
  fetchImpl?: typeof fetch;
  audit?: AuditWriter;
  policy?: PolicyEngine;
  rateLimiter?: RateLimiter;
  logger?: Logger;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  gmailTimeoutMs?: number;
  docsTimeoutMs?: number;
  store?: TokenStore;
}): Promise<App> {
  assertEncryptionKey(options.config);
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? delay;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger =
    options.logger ??
    createLogger({
      level: options.config.logLevel,
      logContent: options.config.logContent,
      secrets: [options.config.googleOauthClientSecret, options.config.tokenEncryptionKey].filter((value) => value.length > 0),
      now: clock,
    });
  const cipher = new TokenCipher(encryptionKeyFromBase64(options.config.tokenEncryptionKey));
  const store = options.store ?? openStore(options.config, cipher);
  if (store instanceof PostgresTokenStore) await store.ready();
  try {
    await store.purgeRetention(clock(), options.config.auditRetentionDays, options.config.idempotencyTtlHours);
  } catch (error) {
    logger.error("retention purge failed", {
      detail: error instanceof Error ? error.message : "The token store could not be purged.",
    });
  }
  const metrics = loggingMetrics(logger);
  const tokens = new AccessTokenCache(store, fetchImpl, options.config, clock, metrics, logger);
  const audit = options.audit ?? new SqliteAuditWriter(store, options.config.logContent);
  const policy = options.policy ?? new EnvAllowlistPolicy(options.config);
  const rateLimiter =
    options.rateLimiter ??
    new InProcessRateLimiter(
      {
        perAccountPerMinute: options.config.rateLimitPerAccountPerMinute,
        perPrincipalPerMinute: options.config.rateLimitPerPrincipalPerMinute,
        maxConcurrencyPerAccount: options.config.maxConcurrencyPerAccount,
      },
      metrics,
    );
  const idempotency = new IdempotencyService(store, options.config.idempotencyLeaseSeconds, clock, metrics);
  const gmail = new GmailClient(fetchImpl, options.config.upstreamMaxAttempts, options.gmailTimeoutMs ?? 30_000, clock, sleep);
  const docsClient = new DocsClient(
    fetchImpl,
    options.config.docsAppendMaxAttempts,
    options.docsTimeoutMs ?? 30_000,
    clock,
    sleep,
  );
  const oauth = new OAuthFlow(options.config, store, fetchImpl, audit, clock, tokens);
  const accounts = new AccountService(options.config, store, oauth);
  const email = new EmailService(options.config, store, tokens, gmail, idempotency, policy, rateLimiter, audit, logger, clock, metrics);
  const docs = new DocsService(options.config, store, tokens, docsClient, idempotency, policy, rateLimiter, audit, logger, clock, metrics);
  return {
    config: options.config,
    store,
    oauth,
    accounts,
    email,
    docs,
    audit,
    logger,
    metrics,
    close: () => store.close(),
  };
}

function openStore(config: AppConfig, cipher: TokenCipher): TokenStore {
  if (config.tokenStore === "postgres") {
    if (!config.tokenStoreDatabaseUrl) {
      throw new ConfigError("TOKEN_STORE_DATABASE_URL is required when TOKEN_STORE=postgres.");
    }
    return new PostgresTokenStore(createPgSql(config.tokenStoreDatabaseUrl), cipher);
  }
  return new SqliteTokenStore(config.tokenStoreSqlitePath, cipher);
}
