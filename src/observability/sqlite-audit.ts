import type { TokenStore } from "../auth/token-store.js";
import { redact } from "../policy/redaction.js";
import type { AuditEvent, AuditWriter } from "./audit.js";

export class SqliteAuditWriter implements AuditWriter {
  constructor(
    private readonly store: TokenStore,
    private readonly logContent: boolean,
  ) {}

  async write(event: AuditEvent): Promise<void> {
    const counts = event.recipient_counts;
    const domains = event.recipient_domains;
    const redacted = redact(
      {
        ...event,
        recipient_counts: undefined,
        recipient_domains: undefined,
      },
      { logContent: this.logContent },
    ) as AuditEvent;
    await this.store.insertAudit({
      ...redacted,
      ...(counts ? { recipient_counts: counts } : {}),
      ...(domains ? { recipient_domains: domains.map((domain) => String(redact(domain, { logContent: this.logContent }))) } : {}),
    });
  }
}
