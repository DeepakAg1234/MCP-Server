import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL } from "../../src/domain/tools.js";
import {
  DOC_ID,
  PLANTED,
  childEnv,
  connectServer,
  seedUser,
  startFakeGoogle,
  workspaceDir,
} from "../contract/harness.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

function envelope(result: { content?: ReadonlyArray<{ type: string; text?: string }>; isError?: boolean }) {
  return JSON.parse(result.content?.find((item) => item.type === "text")?.text ?? "{}") as {
    ok: boolean;
    warnings?: Array<{ code: string }>;
    error?: { code: string; message: string; retry_after_seconds?: number };
    result?: { message_id?: string };
  };
}

describe("stdio security", () => {
  it("stops disallowed recipients and documents before Google is called", async () => {
    const dir = workspaceDir();
    const dbPath = join(dir, "tokens.sqlite");
    const key = randomBytes(32).toString("base64");
    const fake = await startFakeGoogle();
    closers.push(() => fake.close());
    await seedUser({ dbPath, key, userId: "local", email: "ada@example.com", sub: "sub-ada" });
    const connected = await connectServer(
      childEnv({
        TOKEN_ENCRYPTION_KEY: key,
        TOKEN_STORE_SQLITE_PATH: dbPath,
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
        GOOGLE_API_ORIGIN: fake.origin,
        ALLOW_RECIPIENT_DOMAINS: "example.com",
        ALLOW_DOCUMENT_IDS: DOC_ID,
        LOG_CONTENT: "false",
      }),
    );
    closers.push(connected.close);
    const mail = envelope(
      await connected.client.callTool({
        name: TOOL.sendEmail,
        arguments: { to: ["ada@other.test"], subject: "Nope", body: "Hi" },
      }),
    );
    expect(mail.ok).toBe(false);
    expect(mail.error?.code).toBe("ACCESS_DENIED");
    expect(mail.error?.message).toBe("recipient domain is not allowed");
    expect(fake.calls.gmail).toBe(0);
    expect(fake.calls.token).toBe(0);

    const doc = envelope(
      await connected.client.callTool({
        name: TOOL.appendContent,
        arguments: { document_id: "1OtherDocIdYYYYYYYYY", content: "nope" },
      }),
    );
    expect(doc.error?.code).toBe("ACCESS_DENIED");
    expect(doc.error?.message).toBe("document is not allowed");
    expect(fake.calls.docsGet).toBe(0);
  }, 30_000);

  it("rate limits a burst and writes an audit row without BCC or body", async () => {
    const dir = workspaceDir();
    const dbPath = join(dir, "tokens.sqlite");
    const key = randomBytes(32).toString("base64");
    const fake = await startFakeGoogle();
    closers.push(() => fake.close());
    await seedUser({ dbPath, key, userId: "local", email: "ada@example.com", sub: "sub-ada" });
    const connected = await connectServer(
      childEnv({
        TOKEN_ENCRYPTION_KEY: key,
        TOKEN_STORE_SQLITE_PATH: dbPath,
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
        GOOGLE_API_ORIGIN: fake.origin,
        RATE_LIMIT_PER_ACCOUNT_PER_MINUTE: "1",
        LOG_CONTENT: "false",
      }),
    );
    closers.push(connected.close);
    const first = envelope(
      await connected.client.callTool({
        name: TOOL.sendEmail,
        arguments: {
          to: ["ada@example.com"],
          bcc: [PLANTED.bcc],
          subject: "Hello",
          body: PLANTED.body,
          idempotency_key: "rate-1",
        },
      }),
    );
    expect(first.ok).toBe(true);
    const second = envelope(
      await connected.client.callTool({
        name: TOOL.sendEmail,
        arguments: {
          to: ["ada@example.com"],
          subject: "Hello again",
          body: "Second",
          idempotency_key: "rate-2",
        },
      }),
    );
    expect(second.error?.code).toBe("RATE_LIMITED");
    expect(second.error?.retry_after_seconds).toBeGreaterThan(0);
    expect(fake.calls.gmail).toBe(1);

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = db.prepare("SELECT * FROM audit_events").all() as Array<Record<string, unknown>>;
    db.close();
    const dumped = JSON.stringify(rows);
    expect(rows.some((row) => row.outcome === "success" && row.recipient_bcc === 1)).toBe(true);
    expect(dumped).not.toContain(PLANTED.bcc);
    expect(dumped).not.toContain(PLANTED.body);
    expect(dumped).not.toContain(PLANTED.refresh);
    expect(dumped).not.toContain(PLANTED.access);
    expect(dumped).not.toContain(PLANTED.secret);
  }, 30_000);

  it("keeps planted credentials out of stderr and the tool result", async () => {
    const dir = workspaceDir();
    const dbPath = join(dir, "tokens.sqlite");
    const key = randomBytes(32).toString("base64");
    const fake = await startFakeGoogle();
    closers.push(() => fake.close());
    await seedUser({
      dbPath,
      key,
      userId: "local",
      email: "ada@example.com",
      sub: "sub-ada",
      refreshToken: PLANTED.refresh,
    });
    const connected = await connectServer(
      childEnv({
        TOKEN_ENCRYPTION_KEY: key,
        TOKEN_STORE_SQLITE_PATH: dbPath,
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
        GOOGLE_API_ORIGIN: fake.origin,
        LOG_CONTENT: "false",
      }),
    );
    closers.push(connected.close);
    const result = await connected.client.callTool({
      name: TOOL.sendEmail,
      arguments: { to: ["ada@example.com"], subject: "Hello", body: PLANTED.body },
    });
    const captured = `${connected.stderr()}\n${JSON.stringify(result)}`;
    expect(captured).not.toContain(PLANTED.refresh);
    expect(captured).not.toContain(PLANTED.access);
    expect(captured).not.toContain(PLANTED.secret);
  }, 30_000);

  it("rejects a CR/LF subject before any MIME header is sent", async () => {
    const dir = workspaceDir();
    const dbPath = join(dir, "tokens.sqlite");
    const key = randomBytes(32).toString("base64");
    const fake = await startFakeGoogle();
    closers.push(() => fake.close());
    await seedUser({ dbPath, key, userId: "local", email: "ada@example.com", sub: "sub-ada" });
    const connected = await connectServer(
      childEnv({
        TOKEN_ENCRYPTION_KEY: key,
        TOKEN_STORE_SQLITE_PATH: dbPath,
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
        GOOGLE_API_ORIGIN: fake.origin,
      }),
    );
    closers.push(connected.close);
    const result = envelope(
      await connected.client.callTool({
        name: TOOL.sendEmail,
        arguments: {
          to: ["ada@example.com"],
          subject: "Hello\r\nBcc: evil@example.com",
          body: "Hi",
        },
      }),
    );
    expect(result.error?.code).toBe("INVALID_ARGUMENT");
    expect(fake.calls.gmail).toBe(0);
  }, 30_000);

  it("isolates two principals that share a store", async () => {
    const dir = workspaceDir();
    const dbPath = join(dir, "tokens.sqlite");
    const key = randomBytes(32).toString("base64");
    const fake = await startFakeGoogle();
    closers.push(() => fake.close());
    const accountA = await seedUser({ dbPath, key, userId: "user-a", email: "a@example.com", sub: "sub-a" });
    const accountB = await seedUser({ dbPath, key, userId: "user-b", email: "b@example.com", sub: "sub-b" });
    const shared = {
      TOKEN_ENCRYPTION_KEY: key,
      TOKEN_STORE_SQLITE_PATH: dbPath,
      GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
      GOOGLE_API_ORIGIN: fake.origin,
      TENANT_ID: "local",
    };
    const clientA = await connectServer(childEnv({ ...shared, USER_ID: "user-a" }));
    const clientB = await connectServer(childEnv({ ...shared, USER_ID: "user-b" }));
    closers.push(clientA.close, clientB.close);
    const listA = envelope(await clientA.client.callTool({ name: TOOL.listAccounts, arguments: {} }));
    const listB = envelope(await clientB.client.callTool({ name: TOOL.listAccounts, arguments: {} }));
    expect(JSON.stringify(listA)).toContain("a@example.com");
    expect(JSON.stringify(listA)).not.toContain("b@example.com");
    expect(JSON.stringify(listB)).toContain("b@example.com");
    expect(JSON.stringify(listB)).not.toContain("a@example.com");
    const foreign = envelope(
      await clientA.client.callTool({
        name: TOOL.sendEmail,
        arguments: { account_id: accountB, to: ["ada@example.com"], subject: "Hi", body: "Hi" },
      }),
    );
    expect(foreign.error?.code).toBe("ACCOUNT_NOT_FOUND");
    expect(accountA).not.toBe(accountB);
    expect(fake.calls.gmail).toBe(0);
  }, 30_000);

  it("replays the same idempotency key and conflicts when the body changes", async () => {
    const dir = workspaceDir();
    const dbPath = join(dir, "tokens.sqlite");
    const key = randomBytes(32).toString("base64");
    const fake = await startFakeGoogle();
    closers.push(() => fake.close());
    await seedUser({ dbPath, key, userId: "local", email: "ada@example.com", sub: "sub-ada" });
    const connected = await connectServer(
      childEnv({
        TOKEN_ENCRYPTION_KEY: key,
        TOKEN_STORE_SQLITE_PATH: dbPath,
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
        GOOGLE_API_ORIGIN: fake.origin,
      }),
    );
    closers.push(connected.close);
    const first = envelope(
      await connected.client.callTool({
        name: TOOL.sendEmail,
        arguments: {
          to: ["ada@example.com"],
          subject: "Hello",
          body: "Same",
          idempotency_key: "idem-1",
        },
      }),
    );
    const replay = envelope(
      await connected.client.callTool({
        name: TOOL.sendEmail,
        arguments: {
          to: ["ada@example.com"],
          subject: "Hello",
          body: "Same",
          idempotency_key: "idem-1",
        },
      }),
    );
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.warnings?.some((warning) => warning.code === "IDEMPOTENCY_REPLAY")).toBe(true);
    expect(replay.result?.message_id).toBe(first.result?.message_id);
    const conflict = envelope(
      await connected.client.callTool({
        name: TOOL.sendEmail,
        arguments: {
          to: ["ada@example.com"],
          subject: "Hello",
          body: "Different",
          idempotency_key: "idem-1",
        },
      }),
    );
    expect(conflict.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(fake.calls.gmail).toBe(1);
  }, 30_000);
});
