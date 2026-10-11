export type AuditOutcome = "success" | "error" | "replay";

export type AuditEvent = {
  operation_id: string;
  tenant_id: string;
  user_id: string;
  account_id: string | null;
  tool: string;
  outcome: AuditOutcome;
  error_code: string;
  latency_ms: number;
  idempotency_replay: boolean;
  recipient_counts?: { to: number; cc: number; bcc: number };
  recipient_domains?: string[];
  document_id?: string;
  created_at: string;
};

export interface AuditWriter {
  write(event: AuditEvent): void | Promise<void>;
}

export class MemoryAuditWriter implements AuditWriter {
  readonly events: AuditEvent[] = [];

  write(event: AuditEvent): void {
    this.events.push(structuredClone(event));
  }
}
