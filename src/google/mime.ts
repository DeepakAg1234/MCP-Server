import { assertHeaderText } from "./address.js";

export type MimeInput = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyFormat: "plain" | "html";
};

/** Returned to callers and logs. BCC is intentionally absent. */
export type MimePreview = {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  contentType: string;
};

export type BuiltMime = {
  raw: string;
  preview: MimePreview;
};

const SERVER_HEADERS = ["from", "to", "cc", "bcc", "subject", "mime-version", "content-type", "content-transfer-encoding"] as const;

export function serverHeaderNames(): readonly string[] {
  return SERVER_HEADERS;
}

function encodeSubject(subject: string): string {
  if (/^[\u0020-\u007E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

export function buildMime(input: MimeInput): BuiltMime {
  for (const address of [input.from, ...input.to, ...input.cc, ...input.bcc]) {
    const safe = assertHeaderText(address, "address");
    if (!safe.ok) throw new Error(safe.message);
  }
  const subject = assertHeaderText(input.subject, "subject");
  if (!subject.ok) throw new Error(subject.message);

  const contentType = input.bodyFormat === "html" ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
  ];
  if (input.cc.length > 0) lines.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc.length > 0) lines.push(`Bcc: ${input.bcc.join(", ")}`);
  lines.push(
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}`,
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeBody(input.body),
  );
  const message = `${lines.join("\r\n")}`;
  return {
    raw: Buffer.from(message, "utf8").toString("base64url"),
    preview: {
      from: input.from,
      to: [...input.to],
      cc: [...input.cc],
      subject: input.subject,
      contentType,
    },
  };
}

export function decodeRawMime(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}
