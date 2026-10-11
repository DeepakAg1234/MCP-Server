import type { AppConfig } from "../config/env.js";
import type { AccessTokenCache } from "../auth/access-token-cache.js";
import type { AccountRecord, TokenStore } from "../auth/token-store.js";
import type { InvocationContext } from "../domain/context.js";
import { failure, success, WARNING, type Envelope, type FailureEnvelope, type Warning } from "../domain/envelope.js";
import { GoogleApiError } from "../domain/errors.js";
import { requestHash } from "../domain/hash.js";
import { missingScopesFor, TOOL } from "../domain/tools.js";
import type { GmailClient } from "../google/gmail-client.js";
import { sanitizeHtml } from "../google/html.js";
import { buildMime } from "../google/mime.js";
import type { AuditWriter } from "../observability/audit.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { RateLimiter } from "../policy/rate-limiter.js";
import { domainOf } from "../google/address.js";
import type { IdempotencyService } from "./idempotency-service.js";
import { parseGmailSendInput } from "../tools/validate.js";

export type GmailSendResult = {
  message_id: string;
  thread_id?: string;
  account_id: string;
  status: "sent";
  recipient_count: number;
};

export class EmailService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: TokenStore,
    private readonly tokens: AccessTokenCache,
    private readonly gmail: GmailClient,
    private readonly idempotency: IdempotencyService,
    private readonly policy: PolicyEngine,
    private readonly rateLimiter: RateLimiter,
    private readonly audit: AuditWriter,
    private readonly logger: Logger,
    private readonly clock: () => Date,
    private readonly metrics: Metrics,
  ) {}

  async send(ctx: InvocationContext, input: unknown): Promise<Envelope<GmailSendResult>> {
    const started = Date.now();
    const parsed = parseGmailSendInput(input, this.config);
    if (!parsed.ok) {
      return await this.fail(ctx, started, null, null, failure({
        tool: TOOL.sendEmail,
        operationId: ctx.operationId,
        code: "INVALID_ARGUMENT",
        message: parsed.message,
      }));
    }
    const message = parsed.value;
    const account = await this.resolve(ctx, message.accountId);
    if (!account) {
      return await this.fail(ctx, started, message.accountId ?? null, message, failure({
        tool: TOOL.sendEmail,
        operationId: ctx.operationId,
        code: "ACCOUNT_NOT_FOUND",
        message: "No Google account is available for this user.",
        nextAction: "Call google_list_accounts, or google_begin_authorization to connect one.",
      }));
    }
    if (account.status === "reauthorization_required" || !account.hasRefreshToken) {
      return await this.fail(ctx, started, account.accountId, message, failure({
        tool: TOOL.sendEmail,
        operationId: ctx.operationId,
        code: "UNAUTHENTICATED",
        message: "The selected account must be authorized again.",
        nextAction: "Call google_begin_authorization with capability gmail.send for this account.",
      }));
    }
    const missing = missingScopesFor("gmail.send", account.grantedScopes);
    if (missing.length > 0) {
      return await this.fail(ctx, started, account.accountId, message, failure({
        tool: TOOL.sendEmail,
        operationId: ctx.operationId,
        code: "INSUFFICIENT_SCOPE",
        message: "The selected account is not authorized to send email.",
        nextAction: "Call google_begin_authorization with capability gmail.send for this account.",
      }));
    }

    const decision = this.policy.evaluate({
      tool: TOOL.sendEmail,
      accountId: account.accountId,
      recipientDomains: [...message.to, ...message.cc].map((address) => domainOf(address)),
      bccDomains: message.bcc.map((address) => domainOf(address)),
    });
    if (!decision.allowed) {
      return await this.fail(ctx, started, account.accountId, message, failure({
        tool: TOOL.sendEmail,
        operationId: ctx.operationId,
        code: "ACCESS_DENIED",
        message: decision.message,
      }));
    }
    const limitRequest = {
      tool: TOOL.sendEmail,
      accountId: account.accountId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    };
    const limit = this.rateLimiter.take(limitRequest);
    if (!limit.allowed) {
      return await this.fail(ctx, started, account.accountId, message, failure({
        tool: TOOL.sendEmail,
        operationId: ctx.operationId,
        code: "RATE_LIMITED",
        message: "The account is over its local send limit.",
        retryable: true,
        retryAfterSeconds: limit.retryAfterSeconds,
      }));
    }

    try {
    let body = message.body;
    const warnings: Warning[] = [];
    if (message.bodyFormat === "html") {
      const sanitized = sanitizeHtml(body);
      body = sanitized.html;
      if (sanitized.changed) warnings.push(WARNING.htmlSanitized);
    }
    if (message.replyToMessageId) {
      const prior = await this.store.findSentMessage(ctx.tenantId, ctx.userId, account.accountId, message.replyToMessageId);
      if (!prior?.threadId) {
        return await this.fail(ctx, started, account.accountId, message, failure({
          tool: TOOL.sendEmail,
          operationId: ctx.operationId,
          code: "INVALID_ARGUMENT",
          message: "reply_to_message_id does not match a message this account sent through this server.",
          nextAction: "Pass a message_id previously returned by gmail_send_email for this account.",
        }));
      }
    }

    const hash = requestHash({
      account_id: account.accountId,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      body,
      body_format: message.bodyFormat,
      reply_to_message_id: message.replyToMessageId ?? null,
    });
    const idem = await this.idempotency.begin(ctx, TOOL.sendEmail, message.idempotencyKey, hash);
    if (idem.type === "replay" || idem.type === "stop") {
      const envelope = idem.envelope as Envelope<GmailSendResult>;
      await this.auditWrite(ctx, started, account.accountId, message, envelope, idem.type === "replay");
      return envelope;
    }

    if (!message.idempotencyKey) warnings.push(WARNING.idempotencyKeyMissing);
    warnings.push(WARNING.deliveryNotGuaranteed);

    try {
      const accessToken = await this.tokens.getAccessToken(ctx, account);
      const mime = buildMime({
        from: account.email,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        body,
        bodyFormat: message.bodyFormat,
      });
      const thread = message.replyToMessageId
        ? await this.store.findSentMessage(ctx.tenantId, ctx.userId, account.accountId, message.replyToMessageId)
        : null;
      const sent = await this.gmail.send(accessToken, mime.raw, thread?.threadId ?? undefined);
      const result: GmailSendResult = {
        message_id: sent.messageId,
        account_id: account.accountId,
        status: "sent",
        recipient_count: message.to.length + message.cc.length + message.bcc.length,
      };
      if (sent.threadId) result.thread_id = sent.threadId;
      const envelope = success(TOOL.sendEmail, ctx.operationId, result, warnings);
      await this.store.recordSentMessage({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        accountId: account.accountId,
        messageId: sent.messageId,
        threadId: sent.threadId ?? null,
        createdAt: this.clock().toISOString(),
      });
      await this.idempotency.complete(ctx, TOOL.sendEmail, message.idempotencyKey, envelope);
      await this.auditWrite(ctx, started, account.accountId, message, envelope, false);
      this.logger.info("gmail send submitted", {
        operation_id: ctx.operationId,
        tool: TOOL.sendEmail,
        account_id: account.accountId,
      });
      return envelope;
    } catch (error) {
      return await this.fromGoogleError(ctx, started, account, message, message.idempotencyKey, error);
    }
    } finally {
      this.rateLimiter.release(limitRequest);
    }
  }

  private async resolve(ctx: InvocationContext, accountId: string | undefined): Promise<AccountRecord | null> {
    if (accountId) return this.store.getAccount(ctx.tenantId, ctx.userId, accountId);
    if (this.config.defaultAccountId) {
      return this.store.getAccount(ctx.tenantId, ctx.userId, this.config.defaultAccountId);
    }
    return this.store.getDefaultAccount(ctx.tenantId, ctx.userId);
  }

  private async fromGoogleError(
    ctx: InvocationContext,
    started: number,
    account: AccountRecord,
    message: { to: string[]; cc: string[]; bcc: string[] },
    key: string | undefined,
    error: unknown,
  ): Promise<FailureEnvelope> {
    if (error instanceof GoogleApiError) {
      this.metrics.increment("google_api_errors_total", { api: "gmail", error_code: error.code });
    }
    const api = error instanceof GoogleApiError
      ? error
      : new GoogleApiError({ code: "INTERNAL_ERROR", message: "The send could not be completed." });
    if (api.code === "UNAUTHENTICATED") {
      await this.store.markReauthorizationRequired(ctx.tenantId, ctx.userId, account.accountId, this.clock().toISOString());
      this.tokens.drop(account.accountId);
    }
    const envelope = failure({
      tool: TOOL.sendEmail,
      operationId: ctx.operationId,
      code: api.code,
      message: api.message,
      retryable: api.ambiguous ? false : api.retryable,
      retryAfterSeconds: api.retryAfterSeconds,
      nextAction: api.code === "UNAUTHENTICATED" || api.code === "INSUFFICIENT_SCOPE"
        ? "Call google_begin_authorization with capability gmail.send for this account."
        : api.ambiguous
          ? "Confirm whether the message was sent. Use a new idempotency key only if it was not."
          : undefined,
    });
    if (api.ambiguous) await this.idempotency.markUnknown(ctx, TOOL.sendEmail, key, envelope);
    else await this.idempotency.fail(ctx, TOOL.sendEmail, key, envelope);
    await this.auditWrite(ctx, started, account.accountId, message, envelope, false);
    this.logger.error("gmail send failed", {
      operation_id: ctx.operationId,
      tool: TOOL.sendEmail,
      error_code: api.code,
      account_id: account.accountId,
    });
    return envelope;
  }

  private async fail(
    ctx: InvocationContext,
    started: number,
    accountId: string | null,
    message: { to: string[]; cc: string[]; bcc: string[] } | null,
    envelope: FailureEnvelope,
  ): Promise<FailureEnvelope> {
    await this.auditWrite(ctx, started, accountId, message, envelope, false);
    this.logger.error("gmail send rejected", {
      operation_id: ctx.operationId,
      tool: TOOL.sendEmail,
      error_code: envelope.error.code,
      account_id: accountId,
    });
    return envelope;
  }

  private async auditWrite(
    ctx: InvocationContext,
    started: number,
    accountId: string | null,
    message: { to: string[]; cc: string[]; bcc: string[] } | null,
    envelope: Envelope,
    replay: boolean,
  ): Promise<void> {
    const domains = message ? [...message.to, ...message.cc].map((address) => domainOf(address)) : undefined;
    await this.audit.write({
      operation_id: envelope.operation_id,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      account_id: accountId,
      tool: TOOL.sendEmail,
      outcome: replay ? "replay" : envelope.ok ? "success" : "error",
      error_code: envelope.ok ? "" : envelope.error.code,
      latency_ms: Date.now() - started,
      idempotency_replay: replay,
      recipient_counts: message
        ? { to: message.to.length, cc: message.cc.length, bcc: message.bcc.length }
        : { to: 0, cc: 0, bcc: 0 },
      ...(this.config.auditRecipientDomains && domains ? { recipient_domains: domains } : {}),
      created_at: this.clock().toISOString(),
    });
  }
}
