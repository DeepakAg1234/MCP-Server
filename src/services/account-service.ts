import type { AppConfig } from "../config/env.js";
import type { TokenStore } from "../auth/token-store.js";
import type { BeginAuthorizationResult, OAuthFlow } from "../auth/oauth-flow.js";
import type { InvocationContext } from "../domain/context.js";
import { failure, success, type Envelope } from "../domain/envelope.js";
import { missingScopesFor, TOOL, type StatusCapability } from "../domain/tools.js";
import {
  parseAuthorizationStatusInput,
  parseBeginAuthorizationInput,
  parseListAccountsInput,
} from "../tools/validate.js";

export type AccountSummary = {
  account_id: string;
  email: string;
  display_name: string;
  granted_scopes: string[];
  status: "active" | "reauthorization_required";
  default: boolean;
};

export class AccountService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: TokenStore,
    private readonly oauth: OAuthFlow,
  ) {}

  async list(ctx: InvocationContext, input: unknown): Promise<Envelope<{ accounts: AccountSummary[] }>> {
    const parsed = parseListAccountsInput(input);
    if (!parsed.ok) {
      return failure({
        tool: TOOL.listAccounts,
        operationId: ctx.operationId,
        code: "INVALID_ARGUMENT",
        message: parsed.message,
      });
    }
    const accounts = (await this.store.listAccounts(ctx.tenantId, ctx.userId)).map((account) => ({
      account_id: account.accountId,
      email: account.email,
      display_name: account.displayName,
      granted_scopes: account.grantedScopes,
      status: account.status,
      default: this.isDefault(account.accountId, account.isDefault),
    }));
    return success(TOOL.listAccounts, ctx.operationId, { accounts });
  }

  async status(ctx: InvocationContext, input: unknown): Promise<Envelope<{
    account_id: string;
    capability: StatusCapability;
    authorized: boolean;
    missing_scopes: string[];
  }>> {
    const parsed = parseAuthorizationStatusInput(input);
    if (!parsed.ok) {
      return failure({
        tool: TOOL.authorizationStatus,
        operationId: ctx.operationId,
        code: "INVALID_ARGUMENT",
        message: parsed.message,
      });
    }
    const account = parsed.value.accountId
      ? await this.store.getAccount(ctx.tenantId, ctx.userId, parsed.value.accountId)
      : this.config.defaultAccountId
        ? await this.store.getAccount(ctx.tenantId, ctx.userId, this.config.defaultAccountId)
        : await this.store.getDefaultAccount(ctx.tenantId, ctx.userId);
    if (!account) {
      return failure({
        tool: TOOL.authorizationStatus,
        operationId: ctx.operationId,
        code: "ACCOUNT_NOT_FOUND",
        message: "No Google account is available for this user.",
        nextAction: "Call google_list_accounts, or google_begin_authorization to connect one.",
      });
    }
    const missing = missingScopesFor(parsed.value.capability, account.grantedScopes);
    return success(TOOL.authorizationStatus, ctx.operationId, {
      account_id: account.accountId,
      capability: parsed.value.capability,
      authorized: missing.length === 0 && account.status === "active" && account.hasRefreshToken,
      missing_scopes: missing,
    });
  }

  async begin(ctx: InvocationContext, input: unknown, redirectUri: string): Promise<Envelope<BeginAuthorizationResult>> {
    const parsed = parseBeginAuthorizationInput(input);
    if (!parsed.ok) {
      return failure({
        tool: TOOL.beginAuthorization,
        operationId: ctx.operationId,
        code: "INVALID_ARGUMENT",
        message: parsed.message,
      });
    }
    return await this.oauth.begin(ctx, {
      capabilities: parsed.value.capabilities,
      ...(parsed.value.accountId ? { accountId: parsed.value.accountId } : {}),
      redirectUri,
    });
  }

  private isDefault(accountId: string, storedDefault: boolean): boolean {
    if (this.config.defaultAccountId) return accountId === this.config.defaultAccountId;
    return storedDefault;
  }
}
