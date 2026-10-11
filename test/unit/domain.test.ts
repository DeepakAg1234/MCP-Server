import { describe, expect, it } from "vitest";
import { domainOf, domainsEqual, parseAddress } from "../../src/google/address.js";
import { planDocsAppend } from "../../src/google/docs-index.js";
import { parseDocumentId } from "../../src/google/document-id.js";
import { sanitizeHtml } from "../../src/google/html.js";
import { buildMime, decodeRawMime } from "../../src/google/mime.js";
import { requestHash } from "../../src/domain/hash.js";
import { translateGoogleError } from "../../src/google/errors.js";
import { parseGmailSendInput } from "../../src/tools/validate.js";
import { testConfig } from "../helpers.js";

describe("addresses", () => {
  it("rejects display names and folds domains", () => {
    expect(parseAddress("Ada <ada@example.com>").ok).toBe(false);
    expect(parseAddress("ada@example.com, bob@example.com").ok).toBe(false);
    const parsed = parseAddress("Ada@Example.COM");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.local).toBe("Ada");
      expect(parsed.value.domain).toBe("example.com");
    }
    expect(domainOf("Ada@Example.COM")).toBe("example.com");
    expect(domainsEqual("Ada@Example.COM", "other@example.com")).toBe(true);
  });

  it("rejects control characters in the subject and enforces the recipient cap", () => {
    const limits = testConfig({ maxRecipients: 2 });
    expect(parseGmailSendInput({
      to: ["ada@example.com"],
      subject: "Hello\r\nBcc: evil@example.com",
      body: "Hi",
    }, limits).ok).toBe(false);
    expect(parseGmailSendInput({
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      subject: "Hello",
      body: "Hi",
    }, limits).ok).toBe(false);
  });
});

describe("mime", () => {
  it("builds plain and html messages without caller headers, and hides bcc from the preview", () => {
    const plain = buildMime({
      from: "ada@example.com",
      to: ["bob@example.com"],
      cc: ["team@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Status",
      body: "Line one\nLine two",
      bodyFormat: "plain",
    });
    const decoded = decodeRawMime(plain.raw);
    const [header = "", body = ""] = decoded.split("\r\n\r\n");
    expect(header.split("\r\n").map((line) => line.split(":")[0])).toEqual([
      "From",
      "To",
      "Cc",
      "Bcc",
      "Subject",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
    expect(header).toContain("Bcc: hidden@example.com");
    expect(header).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(body).toBe("Line one\r\nLine two");
    expect(JSON.stringify(plain.preview)).not.toContain("hidden@example.com");
    expect("bcc" in plain.preview).toBe(false);

    const html = buildMime({
      from: "ada@example.com",
      to: ["bob@example.com"],
      cc: [],
      bcc: [],
      subject: "Café",
      body: "<p>Hi</p>",
      bodyFormat: "html",
    });
    const htmlText = decodeRawMime(html.raw);
    expect(htmlText).toContain("Content-Type: text/html; charset=UTF-8");
    expect(htmlText).toContain("=?UTF-8?B?");
    expect(htmlText).not.toContain("Subject: Café");
  });
});

describe("html", () => {
  it("removes script and javascript urls and hashes stably", () => {
    const dirty = '<p onclick="alert(1)">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>';
    const once = sanitizeHtml(dirty);
    const twice = sanitizeHtml(dirty);
    expect(once.changed).toBe(true);
    expect(once.html).not.toMatch(/<script/i);
    expect(once.html).not.toMatch(/onclick/i);
    expect(once.html).not.toMatch(/javascript:/i);
    expect(once.html).toBe(twice.html);
    expect(requestHash({ body: once.html })).toBe(requestHash({ body: twice.html }));
  });
});

describe("document ids", () => {
  const id = "1AbCdEfGhIjKlMnOpQrSt";

  it("accepts a raw id and a docs url, and rejects http, the wrong host, and userinfo", () => {
    expect(parseDocumentId(id)).toEqual({ ok: true, documentId: id });
    expect(parseDocumentId(`https://docs.google.com/document/d/${id}/edit?usp=sharing#heading`)).toEqual({
      ok: true,
      documentId: id,
    });
    expect(parseDocumentId(`http://docs.google.com/document/d/${id}`).ok).toBe(false);
    expect(parseDocumentId(`https://evil.example/document/d/${id}`).ok).toBe(false);
    expect(parseDocumentId(`https://user:pass@docs.google.com/document/d/${id}`).ok).toBe(false);
    expect(parseDocumentId(`https://docs.google.com:8443/document/d/${id}`).ok).toBe(false);
  });
});

describe("indexes", () => {
  it("handles an empty doc, a non-empty doc, prepend_newline, and a utf-16 emoji", () => {
    const emoji = "👍";
    expect(emoji.length).toBe(2);
    const empty = planDocsAppend(2, emoji, true);
    expect(empty.text).toBe(emoji);
    expect(empty.startIndex).toBe(1);
    expect(empty.endIndex).toBe(3);

    const prefixed = planDocsAppend(5, emoji, true);
    expect(prefixed.text).toBe(`\n${emoji}`);
    expect(prefixed.startIndex).toBe(4);
    expect(prefixed.endIndex).toBe(4 + prefixed.text.length);

    const bare = planDocsAppend(5, emoji, false);
    expect(bare.text).toBe(emoji);
    expect(bare.endIndex - bare.startIndex).toBe(2);
  });
});

describe("google errors", () => {
  it("maps the architecture status table and drops the raw body", () => {
    const secret = "raw-google-body-secret";
    expect(translateGoogleError(401, { error: { status: "UNAUTHENTICATED", message: secret } }).code).toBe("UNAUTHENTICATED");
    expect(translateGoogleError(400, { error: "invalid_grant" }).code).toBe("UNAUTHENTICATED");
    expect(translateGoogleError(403, { error: { status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }], message: secret } }).code).toBe("INSUFFICIENT_SCOPE");
    expect(translateGoogleError(403, { error: { status: "PERMISSION_DENIED", message: secret } }).code).toBe("ACCESS_DENIED");
    expect(translateGoogleError(404, { error: { message: secret } }).code).toBe("NOT_FOUND");
    expect(translateGoogleError(400, { error: { status: "FAILED_PRECONDITION", message: secret } }).code).toBe("CONFLICT");
    const limited = translateGoogleError(429, { error: { message: secret } }, 9);
    expect(limited.code).toBe("RATE_LIMITED");
    expect(limited.retryAfterSeconds).toBe(9);
    expect(translateGoogleError(503, {}).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(translateGoogleError(500, {}).ambiguous).toBe(true);
    expect(translateGoogleError(418, { error: { message: secret } }).message).not.toContain(secret);
  });
});
