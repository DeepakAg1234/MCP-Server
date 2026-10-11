import type { AppConfig } from "../config/env.js";
import type { PolicyDecision, PolicyEngine, PolicyRequest } from "./engine.js";

export class EnvAllowlistPolicy implements PolicyEngine {
  constructor(
    private readonly config: Pick<
      AppConfig,
      "allowAccountIds" | "allowRecipientDomains" | "allowBccDomains" | "allowDocumentIds"
    >,
  ) {}

  evaluate(request: PolicyRequest): PolicyDecision {
    if (this.config.allowAccountIds.length > 0 && !this.config.allowAccountIds.includes(request.accountId)) {
      return { allowed: false, message: "account is not allowed" };
    }
    if (
      request.documentId &&
      this.config.allowDocumentIds.length > 0 &&
      !this.config.allowDocumentIds.includes(request.documentId)
    ) {
      return { allowed: false, message: "document is not allowed" };
    }
    const recipients = request.recipientDomains ?? [];
    if (
      this.config.allowRecipientDomains.length > 0 &&
      recipients.some((domain) => !this.config.allowRecipientDomains.includes(domain))
    ) {
      return { allowed: false, message: "recipient domain is not allowed" };
    }
    const bcc = request.bccDomains ?? [];
    if (bcc.length > 0) {
      const bccList = this.config.allowBccDomains.length > 0 ? this.config.allowBccDomains : this.config.allowRecipientDomains;
      if (bccList.length > 0 && bcc.some((domain) => !bccList.includes(domain))) {
        return { allowed: false, message: "bcc domain is not allowed" };
      }
    }
    return { allowed: true };
  }
}
