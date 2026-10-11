export type AccountStatus = "active" | "reauthorization_required";

export type AccountRecord = {
  accountId: string;
  tenantId: string;
  userId: string;
  googleSub: string;
  email: string;
  displayName: string;
  grantedScopes: string[];
  status: AccountStatus;
  isDefault: boolean;
  hasRefreshToken: boolean;
};

export type OperationStatus = "reserved" | "completed" | "failed" | "unknown";

export type OperationRecord = {
  tenantId: string;
  userId: string;
  tool: string;
  idempotencyKey: string;
  requestHash: string;
  status: OperationStatus;
  leaseUntil: string | null;
  operationId: string;
  envelopeJson: string | null;
};

export type OAuthStateRecord = {
  stateHash: string;
  tenantId: string;
  userId: string;
  requestedScopes: string;
  accountId: string | null;
  expiresAt: string;
  consumedAt: string | null;
};

export type ConsumeStateResult =
  | { ok: true; codeVerifier: string; requestedScopes: string; accountId: string | null }
  | { ok: false; reason: "missing" | "expired" | "reused" | "principal" };

export type SentMessage = {
  messageId: string;
  threadId: string | null;
  accountId: string;
};

export type StoredAuditEvent = {
  operation_id: string;
  tenant_id: string;
  user_id: string;
  account_id: string | null;
  tool: string;
  outcome: "success" | "error" | "replay";
  error_code: string;
  latency_ms: number;
  idempotency_replay: boolean;
  recipient_counts?: { to: number; cc: number; bcc: number };
  recipient_domains?: string[];
  document_id?: string;
  created_at: string;
};

export interface TokenStore {
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
  ping(): Promise<void>;
  findOAuthStateOwner(stateHash: string): Promise<{ tenantId: string; userId: string } | null>;
  upsertConsent(input: {
    tenantId: string;
    userId: string;
    googleSub: string;
    email: string;
    displayName: string;
    grantedScopes: string[];
    refreshToken: string | null;
    now: string;
  }): Promise<AccountRecord>;
  listAccounts(tenantId: string, userId: string): Promise<AccountRecord[]>;
  getAccount(tenantId: string, userId: string, accountId: string): Promise<AccountRecord | null>;
  getDefaultAccount(tenantId: string, userId: string): Promise<AccountRecord | null>;
  markReauthorizationRequired(tenantId: string, userId: string, accountId: string, now: string): Promise<void>;
  readRefreshToken(tenantId: string, userId: string, accountId: string): Promise<string | null>;
  readRefreshCiphertext(tenantId: string, userId: string, accountId: string): Promise<Buffer | null>;
  saveRefreshToken(tenantId: string, userId: string, accountId: string, refreshToken: string, now: string): Promise<void>;
  insertOAuthState(input: {
    stateHash: string;
    tenantId: string;
    userId: string;
    codeVerifier: string;
    requestedScopes: string[];
    accountId?: string;
    expiresAt: string;
  }): Promise<void>;
  consumeOAuthState(input: {
    stateHash: string;
    tenantId: string;
    userId: string;
    now: string;
  }): Promise<ConsumeStateResult>;
  getOperation(tenantId: string, userId: string, tool: string, idempotencyKey: string): Promise<OperationRecord | null>;
  insertOperation(record: OperationRecord & { createdAt: string; updatedAt: string }): Promise<void>;
  updateOperation(record: OperationRecord & { updatedAt: string }): Promise<void>;
  recordSentMessage(input: {
    tenantId: string;
    userId: string;
    accountId: string;
    messageId: string;
    threadId: string | null;
    createdAt: string;
  }): Promise<void>;
  findSentMessage(tenantId: string, userId: string, accountId: string, messageId: string): Promise<SentMessage | null>;
  insertAudit(event: StoredAuditEvent): Promise<void>;
  listAudit(tenantId: string, userId: string): Promise<StoredAuditEvent[]>;
  purgeRetention(now: Date, auditRetentionDays: number, idempotencyTtlHours: number): Promise<void>;
  close(): Promise<void>;
}
