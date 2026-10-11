import { createAccountId } from "../domain/ids.js";
import { TokenCipher } from "./cipher.js";
import { postgresText, type Sql } from "./sql.js";
import type {
  AccountRecord,
  AccountStatus,
  ConsumeStateResult,
  OperationRecord,
  SentMessage,
  StoredAuditEvent,
  TokenStore,
} from "./token-store.js";

type AccountRow = {
  account_id: string;
  tenant_id: string;
  user_id: string;
  google_sub: string;
  email: string;
  display_name: string;
  granted_scopes: string;
  refresh_token_ciphertext: Uint8Array | Buffer | null;
  status: string;
  is_default: number | boolean;
};

type OperationRow = {
  tenant_id: string;
  user_id: string;
  tool: string;
  idempotency_key: string;
  request_hash: string;
  status: OperationRecord["status"];
  lease_until: string | null;
  operation_id: string;
  envelope_json: string | null;
};

type StateRow = {
  state_hash: string;
  tenant_id: string;
  user_id: string;
  code_verifier_ciphertext: Uint8Array | Buffer;
  requested_scopes: string;
  account_id: string | null;
  expires_at: string;
  consumed_at: string | null;
};

function asBuffer(value: Uint8Array | Buffer | null | undefined): Buffer | null {
  if (value == null) return null;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.byteLength === 0 ? null : buffer;
}

function mapAccount(row: AccountRow): AccountRecord {
  const ciphertext = asBuffer(row.refresh_token_ciphertext);
  return {
    accountId: row.account_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    googleSub: row.google_sub,
    email: row.email,
    displayName: row.display_name,
    grantedScopes: row.granted_scopes ? row.granted_scopes.split(" ") : [],
    status: row.status as AccountStatus,
    isDefault: row.is_default === true || Number(row.is_default) === 1,
    hasRefreshToken: ciphertext != null,
  };
}

export class PostgresTokenStore implements TokenStore {
  constructor(
    private readonly sql: Sql,
    private readonly cipher: TokenCipher,
  ) {}

  transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.sql.transaction(async () => fn());
  }

  async ready(): Promise<void> {
    await this.migrate();
  }

  async ping(): Promise<void> {
    await this.sql.query("SELECT 1");
  }

  async findOAuthStateOwner(stateHash: string): Promise<{ tenantId: string; userId: string } | null> {
    const row = await this.one<{ tenant_id: string; user_id: string }>(
      `SELECT tenant_id, user_id FROM oauth_states WHERE state_hash = ?`,
      [stateHash],
    );
    if (!row) return null;
    return { tenantId: row.tenant_id, userId: row.user_id };
  }

  async upsertConsent(input: {
    tenantId: string;
    userId: string;
    googleSub: string;
    email: string;
    displayName: string;
    grantedScopes: string[];
    refreshToken: string | null;
    now: string;
  }): Promise<AccountRecord> {
    return this.transaction(async () => {
      const existing = await this.one<AccountRow>(
        `SELECT * FROM accounts WHERE tenant_id = ? AND user_id = ? AND google_sub = ?`,
        [input.tenantId, input.userId, input.googleSub],
      );
      const scopes = input.grantedScopes.join(" ");
      const ciphertext = input.refreshToken ? this.cipher.encrypt(input.refreshToken) : null;
      if (existing) {
        await this.run(
          `UPDATE accounts
           SET email = ?, display_name = ?, granted_scopes = ?,
               refresh_token_ciphertext = COALESCE(?, refresh_token_ciphertext),
               key_version = ?, status = 'active', updated_at = ?
           WHERE account_id = ?`,
          [input.email, input.displayName, scopes, ciphertext, this.cipher.keyVersion, input.now, existing.account_id],
        );
        return this.requireAccount(input.tenantId, input.userId, existing.account_id);
      }
      const defaults = await this.one<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM accounts WHERE tenant_id = ? AND user_id = ? AND is_default = 1`,
        [input.tenantId, input.userId],
      );
      const accountId = createAccountId();
      await this.run(
        `INSERT INTO accounts (
           account_id, tenant_id, user_id, google_sub, email, display_name, granted_scopes,
           refresh_token_ciphertext, key_version, status, is_default, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
          accountId,
          input.tenantId,
          input.userId,
          input.googleSub,
          input.email,
          input.displayName,
          scopes,
          ciphertext,
          this.cipher.keyVersion,
          Number(defaults?.count ?? 0) === 0 ? 1 : 0,
          input.now,
          input.now,
        ],
      );
      return this.requireAccount(input.tenantId, input.userId, accountId);
    });
  }

  async listAccounts(tenantId: string, userId: string): Promise<AccountRecord[]> {
    const rows = await this.many<AccountRow>(
      `SELECT * FROM accounts WHERE tenant_id = ? AND user_id = ? ORDER BY created_at ASC, account_id ASC`,
      [tenantId, userId],
    );
    return rows.map(mapAccount);
  }

  async getAccount(tenantId: string, userId: string, accountId: string): Promise<AccountRecord | null> {
    const row = await this.one<AccountRow>(
      `SELECT * FROM accounts WHERE tenant_id = ? AND user_id = ? AND account_id = ?`,
      [tenantId, userId, accountId],
    );
    return row ? mapAccount(row) : null;
  }

  async getDefaultAccount(tenantId: string, userId: string): Promise<AccountRecord | null> {
    const row = await this.one<AccountRow>(
      `SELECT * FROM accounts WHERE tenant_id = ? AND user_id = ? AND is_default = 1`,
      [tenantId, userId],
    );
    return row ? mapAccount(row) : null;
  }

  async markReauthorizationRequired(tenantId: string, userId: string, accountId: string, now: string): Promise<void> {
    await this.run(
      `UPDATE accounts
       SET status = 'reauthorization_required', refresh_token_ciphertext = NULL, updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND account_id = ?`,
      [now, tenantId, userId, accountId],
    );
  }

  async readRefreshToken(tenantId: string, userId: string, accountId: string): Promise<string | null> {
    const blob = await this.readRefreshCiphertext(tenantId, userId, accountId);
    if (!blob) return null;
    return this.cipher.decrypt(blob);
  }

  async readRefreshCiphertext(tenantId: string, userId: string, accountId: string): Promise<Buffer | null> {
    const row = await this.one<{ refresh_token_ciphertext: Uint8Array | Buffer | null }>(
      `SELECT refresh_token_ciphertext FROM accounts WHERE tenant_id = ? AND user_id = ? AND account_id = ?`,
      [tenantId, userId, accountId],
    );
    return asBuffer(row?.refresh_token_ciphertext);
  }

  async saveRefreshToken(tenantId: string, userId: string, accountId: string, refreshToken: string, now: string): Promise<void> {
    await this.run(
      `UPDATE accounts
       SET refresh_token_ciphertext = ?, key_version = ?, status = 'active', updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND account_id = ?`,
      [this.cipher.encrypt(refreshToken), this.cipher.keyVersion, now, tenantId, userId, accountId],
    );
  }

  async insertOAuthState(input: {
    stateHash: string;
    tenantId: string;
    userId: string;
    codeVerifier: string;
    requestedScopes: string[];
    accountId?: string;
    expiresAt: string;
  }): Promise<void> {
    await this.run(
      `INSERT INTO oauth_states (
         state_hash, tenant_id, user_id, code_verifier_ciphertext, requested_scopes, account_id, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.stateHash,
        input.tenantId,
        input.userId,
        this.cipher.encrypt(input.codeVerifier),
        input.requestedScopes.join(" "),
        input.accountId ?? null,
        input.expiresAt,
      ],
    );
  }

  async consumeOAuthState(input: { stateHash: string; tenantId: string; userId: string; now: string }): Promise<ConsumeStateResult> {
    return this.transaction(async () => {
      const row = await this.one<StateRow>(`SELECT * FROM oauth_states WHERE state_hash = ? FOR UPDATE`, [input.stateHash]);
      if (!row) return { ok: false as const, reason: "missing" as const };
      if (row.tenant_id !== input.tenantId || row.user_id !== input.userId) {
        return { ok: false as const, reason: "principal" as const };
      }
      if (row.consumed_at) return { ok: false as const, reason: "reused" as const };
      if (Date.parse(row.expires_at) <= Date.parse(input.now)) return { ok: false as const, reason: "expired" as const };
      const updated = await this.run(
        `UPDATE oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL`,
        [input.now, input.stateHash],
      );
      if (updated !== 1) return { ok: false as const, reason: "reused" as const };
      return {
        ok: true as const,
        codeVerifier: this.cipher.decrypt(asBuffer(row.code_verifier_ciphertext) ?? Buffer.alloc(0)),
        requestedScopes: row.requested_scopes,
        accountId: row.account_id,
      };
    });
  }

  async getOperation(tenantId: string, userId: string, tool: string, idempotencyKey: string): Promise<OperationRecord | null> {
    const lock = this.sql.inTransaction() ? " FOR UPDATE" : "";
    const row = await this.one<OperationRow>(
      `SELECT * FROM operations WHERE tenant_id = ? AND user_id = ? AND tool = ? AND idempotency_key = ?${lock}`,
      [tenantId, userId, tool, idempotencyKey],
    );
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      tool: row.tool,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      status: row.status,
      leaseUntil: row.lease_until,
      operationId: row.operation_id,
      envelopeJson: row.envelope_json,
    };
  }

  async insertOperation(record: OperationRecord & { createdAt: string; updatedAt: string }): Promise<void> {
    await this.run(
      `INSERT INTO operations (
         tenant_id, user_id, tool, idempotency_key, request_hash, status, lease_until,
         operation_id, envelope_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.tenantId,
        record.userId,
        record.tool,
        record.idempotencyKey,
        record.requestHash,
        record.status,
        record.leaseUntil,
        record.operationId,
        record.envelopeJson,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async updateOperation(record: OperationRecord & { updatedAt: string }): Promise<void> {
    await this.run(
      `UPDATE operations
       SET request_hash = ?, status = ?, lease_until = ?, operation_id = ?, envelope_json = ?, updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND tool = ? AND idempotency_key = ?`,
      [
        record.requestHash,
        record.status,
        record.leaseUntil,
        record.operationId,
        record.envelopeJson,
        record.updatedAt,
        record.tenantId,
        record.userId,
        record.tool,
        record.idempotencyKey,
      ],
    );
  }

  async recordSentMessage(input: {
    tenantId: string;
    userId: string;
    accountId: string;
    messageId: string;
    threadId: string | null;
    createdAt: string;
  }): Promise<void> {
    await this.run(
      `INSERT INTO sent_messages (tenant_id, user_id, account_id, message_id, thread_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, user_id, message_id) DO UPDATE SET thread_id = excluded.thread_id`,
      [input.tenantId, input.userId, input.accountId, input.messageId, input.threadId, input.createdAt],
    );
  }

  async findSentMessage(tenantId: string, userId: string, accountId: string, messageId: string): Promise<SentMessage | null> {
    const row = await this.one<{ message_id: string; thread_id: string | null; account_id: string }>(
      `SELECT message_id, thread_id, account_id FROM sent_messages
       WHERE tenant_id = ? AND user_id = ? AND account_id = ? AND message_id = ?`,
      [tenantId, userId, accountId, messageId],
    );
    if (!row) return null;
    return { messageId: row.message_id, threadId: row.thread_id, accountId: row.account_id };
  }

  async insertAudit(event: StoredAuditEvent): Promise<void> {
    const counts = event.recipient_counts;
    await this.run(
      `INSERT INTO audit_events (
         operation_id, tenant_id, user_id, account_id, tool, outcome, error_code, latency_ms,
         idempotency_replay, recipient_to, recipient_cc, recipient_bcc, recipient_domains, document_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.operation_id,
        event.tenant_id,
        event.user_id,
        event.account_id,
        event.tool,
        event.outcome,
        event.error_code,
        event.latency_ms,
        event.idempotency_replay ? 1 : 0,
        counts?.to ?? null,
        counts?.cc ?? null,
        counts?.bcc ?? null,
        event.recipient_domains ? JSON.stringify(event.recipient_domains) : null,
        event.document_id ?? null,
        event.created_at,
      ],
    );
  }

  async listAudit(tenantId: string, userId: string): Promise<StoredAuditEvent[]> {
    const rows = await this.many<{
      operation_id: string;
      tenant_id: string;
      user_id: string;
      account_id: string | null;
      tool: string;
      outcome: StoredAuditEvent["outcome"];
      error_code: string;
      latency_ms: number;
      idempotency_replay: number;
      recipient_to: number | null;
      recipient_cc: number | null;
      recipient_bcc: number | null;
      recipient_domains: string | null;
      document_id: string | null;
      created_at: string;
    }>(`SELECT * FROM audit_events WHERE tenant_id = ? AND user_id = ? ORDER BY id`, [tenantId, userId]);
    return rows.map((row) => ({
      operation_id: row.operation_id,
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      account_id: row.account_id,
      tool: row.tool,
      outcome: row.outcome,
      error_code: row.error_code,
      latency_ms: row.latency_ms,
      idempotency_replay: Number(row.idempotency_replay) === 1,
      ...(row.recipient_to == null
        ? {}
        : { recipient_counts: { to: row.recipient_to, cc: row.recipient_cc ?? 0, bcc: row.recipient_bcc ?? 0 } }),
      ...(row.recipient_domains ? { recipient_domains: JSON.parse(row.recipient_domains) as string[] } : {}),
      ...(row.document_id ? { document_id: row.document_id } : {}),
      created_at: row.created_at,
    }));
  }

  async purgeRetention(now: Date, auditRetentionDays: number, idempotencyTtlHours: number): Promise<void> {
    const auditBefore = new Date(now.getTime() - auditRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const idempotencyBefore = new Date(now.getTime() - idempotencyTtlHours * 60 * 60 * 1000).toISOString();
    await this.run(`DELETE FROM audit_events WHERE created_at < ?`, [auditBefore]);
    await this.run(`DELETE FROM operations WHERE status IN ('completed', 'failed', 'unknown') AND updated_at < ?`, [
      idempotencyBefore,
    ]);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  private async migrate(): Promise<void> {
    const statements = `
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        google_sub TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        granted_scopes TEXT NOT NULL,
        refresh_token_ciphertext BYTEA,
        key_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, user_id, google_sub)
      );

      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        code_verifier_ciphertext BYTEA NOT NULL,
        requested_scopes TEXT NOT NULL,
        account_id TEXT,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS operations (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_until TEXT,
        operation_id TEXT NOT NULL,
        envelope_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, user_id, tool, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS sent_messages (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, user_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        operation_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        account_id TEXT,
        tool TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        idempotency_replay INTEGER NOT NULL,
        recipient_to INTEGER,
        recipient_cc INTEGER,
        recipient_bcc INTEGER,
        recipient_domains TEXT,
        document_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_events_tenant_created ON audit_events (tenant_id, created_at);
    `.split(";").map((statement) => statement.trim()).filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await this.sql.query(statement);
    }
  }

  private async one<T extends Record<string, unknown>>(text: string, params: unknown[]): Promise<T | undefined> {
    const result = await this.sql.query<T>(postgresText(text), params);
    return result.rows[0];
  }

  private async many<T extends Record<string, unknown>>(text: string, params: unknown[]): Promise<T[]> {
    const result = await this.sql.query<T>(postgresText(text), params);
    return result.rows;
  }

  private async run(text: string, params: unknown[]): Promise<number> {
    const result = await this.sql.query(postgresText(text), params);
    return result.rowCount;
  }

  private async requireAccount(tenantId: string, userId: string, accountId: string): Promise<AccountRecord> {
    const account = await this.getAccount(tenantId, userId, accountId);
    if (!account) throw new Error("Account disappeared during write.");
    return account;
  }
}
