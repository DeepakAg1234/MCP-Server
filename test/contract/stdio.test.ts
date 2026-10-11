import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL, TOOL_ORDER } from "../../src/domain/tools.js";
import { validateSchema } from "../../src/tools/validate.js";
import {
  DOC_ID,
  PLANTED,
  ROOT,
  childEnv,
  connectServer,
  seedUser,
  startFakeGoogle,
  workspaceDir,
  type FakeGoogle,
} from "./harness.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

function track(close: () => Promise<void>): void {
  closers.push(close);
}

async function session(
  overrides: Record<string, string> = {},
  mode: "legacy" | { pin: "2026-07-28" } = { pin: "2026-07-28" },
): Promise<{
  client: Awaited<ReturnType<typeof connectServer>>["client"];
  stderr: () => string;
  fake: FakeGoogle;
  dbPath: string;
  key: string;
  accountId: string;
}> {
  const dir = workspaceDir();
  const dbPath = join(dir, "tokens.sqlite");
  const key = randomBytes(32).toString("base64");
  const fake = await startFakeGoogle();
  track(() => fake.close());
  const accountId = await seedUser({
    dbPath,
    key,
    userId: "local",
    email: "ada@example.com",
    sub: "sub-ada",
  });
  const connected = await connectServer(
    childEnv({
      TOKEN_ENCRYPTION_KEY: key,
      TOKEN_STORE_SQLITE_PATH: dbPath,
      GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: PLANTED.secret,
      GOOGLE_API_ORIGIN: fake.origin,
      TENANT_ID: "local",
      USER_ID: "local",
      LOG_CONTENT: "false",
      ...overrides,
    }),
    mode,
  );
  track(connected.close);
  return { client: connected.client, stderr: connected.stderr, fake, dbPath, key, accountId };
}

function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

describe("stdio contract", () => {
  it("lists five tools in order with architecture annotations and published schemas", async () => {
    const { client } = await session();
    expect(client.getServerVersion()).toMatchObject({ name: "google-workspace-mcp", version: "0.2.0" });
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_ORDER]);
    expect(JSON.stringify(listed.tools)).not.toContain("x-mcp-header");
    const expected = {
      [TOOL.listAccounts]: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      [TOOL.authorizationStatus]: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      [TOOL.beginAuthorization]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      [TOOL.sendEmail]: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      [TOOL.appendContent]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    };
    for (const tool of listed.tools) {
      const file = JSON.parse(readFileSync(join(ROOT, "schemas", `${tool.name}.schema.json`), "utf8")) as {
        $defs: { output: unknown };
      };
      expect(tool.annotations).toMatchObject(expected[tool.name as keyof typeof expected]);
      expect(tool.inputSchema).toEqual(file);
      expect(tool.outputSchema).toEqual(file.$defs.output);
      expect(tool.description?.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it("sends and appends through the stdio process and validates the envelopes", async () => {
    const { client, fake } = await session();
    const sent = await client.callTool({
      name: TOOL.sendEmail,
      arguments: {
        to: ["ada@example.com"],
        bcc: [PLANTED.bcc],
        subject: "Hello",
        body: PLANTED.body,
        idempotency_key: "send-1",
      },
    });
    const sentEnvelope = JSON.parse(textOf(sent)) as { ok: boolean; tool: string };
    expect(sent.isError).not.toBe(true);
    expect(sent.structuredContent).toEqual(sentEnvelope);
    expect(validateSchema("https://google-workspace-mcp.local/schemas/gmail_send_email.output.json", sentEnvelope)).toEqual({
      ok: true,
    });
    expect(fake.calls.gmail).toBe(1);

    const appended = await client.callTool({
      name: TOOL.appendContent,
      arguments: {
        document_id: DOC_ID,
        content: "hello",
        idempotency_key: "append-1",
      },
    });
    const appendedEnvelope = JSON.parse(textOf(appended));
    expect(appended.isError).not.toBe(true);
    expect(appended.structuredContent).toEqual(appendedEnvelope);
    expect(validateSchema("https://google-workspace-mcp.local/schemas/gdocs_append_content.output.json", appendedEnvelope)).toEqual({
      ok: true,
    });
    expect(fake.calls.docsUpdate).toBe(1);
  }, 30_000);

  it("returns a protocol error for an unknown tool and INVALID_ARGUMENT for a bad email", async () => {
    const { client, fake } = await session();
    let code: number | undefined;
    try {
      await client.callTool({ name: "not_a_real_tool", arguments: {} });
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(-32602);

    const bad = await client.callTool({
      name: TOOL.sendEmail,
      arguments: { to: ["ada@example.com"], subject: "Hello", body: "Hi", extra: true },
    });
    expect(bad.isError).toBe(true);
    const envelope = JSON.parse(textOf(bad)) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("INVALID_ARGUMENT");
    expect(bad.structuredContent).toEqual(envelope);
    expect(fake.calls.gmail).toBe(0);
  }, 30_000);

  it("answers ping for a legacy client and writes only JSON-RPC to stdout", async () => {
    const tee = join(workspaceDir(), "stdout.log");
    const { client } = await session({ MCP_STDOUT_TEE: tee }, "legacy");
    await client.ping();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_ORDER]);
    const lines = readFileSync(tee, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc).toBe("2.0");
    }
  }, 30_000);
});
