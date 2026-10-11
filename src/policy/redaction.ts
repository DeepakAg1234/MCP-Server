const SECRET_KEYS = new Set([
  "refresh_token",
  "access_token",
  "id_token",
  "code_verifier",
  "client_secret",
  "authorization",
  "cookie",
  "set-cookie",
  "refresh_token_ciphertext",
  "code",
  "bcc",
]);

const CONTENT_KEYS = new Set(["body", "content", "html", "text"]);

export type RedactOptions = {
  logContent: boolean;
  secrets?: readonly string[];
};

function collectPlanted(value: unknown, planted: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPlanted(item, planted);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lowered = key.toLowerCase();
    if (SECRET_KEYS.has(lowered) || lowered === "bcc") {
      collectStrings(child, planted);
    }
    collectPlanted(child, planted);
  }
}

function collectStrings(value: unknown, planted: Set<string>): void {
  if (typeof value === "string" && value.length >= 4) {
    planted.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, planted);
  }
}

function scrub(value: string, planted: readonly string[]): string {
  let next = value;
  for (const secret of planted) {
    if (secret.length >= 4 && next.includes(secret)) {
      next = next.split(secret).join("[REDACTED]");
    }
  }
  next = next.replace(/\bya29\.[A-Za-z0-9_\-]+/g, "[REDACTED]");
  next = next.replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  return next;
}

function walk(value: unknown, options: RedactOptions, planted: readonly string[]): unknown {
  if (typeof value === "string") return scrub(value, planted);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, options, planted));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (SECRET_KEYS.has(lowered)) {
      output[key] = "[REDACTED]";
      continue;
    }
    if (!options.logContent && CONTENT_KEYS.has(lowered) && typeof child === "string") {
      output[key] = { redacted: true, length: Buffer.byteLength(child, "utf8") };
      continue;
    }
    output[key] = walk(child, options, planted);
  }
  return output;
}

export function redact(value: unknown, options: RedactOptions): unknown {
  const planted = new Set<string>();
  for (const secret of options.secrets ?? []) {
    if (secret.length >= 4) planted.add(secret);
  }
  collectPlanted(value, planted);
  return walk(value, options, [...planted]);
}
