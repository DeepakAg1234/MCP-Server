import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/observability/logger.js";

describe("redaction", () => {
  it("drops a known token, the client secret, bcc, and the body when content logging is off", () => {
    const token = "ya29.access-token-secret-value";
    const secret = "test-client-secret-value";
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      logContent: false,
      secrets: [token, secret],
      write: (line) => lines.push(line),
    });
    logger.info(`sending with ${token}`, {
      access_token: token,
      client_secret: secret,
      bcc: ["hidden@example.com"],
      body: "hello secret body",
      authorization: "Bearer refresh-token-secret-value",
    });
    const line = lines.join("\n");
    expect(line).not.toContain(token);
    expect(line).not.toContain(secret);
    expect(line).not.toContain("hidden@example.com");
    expect(line).not.toContain("hello secret body");
    expect(line).not.toContain("refresh-token-secret-value");
    expect(line).toContain("length");
  });
});
