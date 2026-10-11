import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32 ULID: 48-bit time (10 chars) and 80-bit randomness (16 chars). */
export function ulid(timestamp = Date.now()): string {
  let time = timestamp;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = ALPHABET[time % 32] ?? "0";
    time = Math.floor(time / 32);
  }

  const bytes = randomBytes(10);
  let rand = 0n;
  for (const byte of bytes) {
    rand = (rand << 8n) | BigInt(byte);
  }
  const randChars = new Array<string>(16);
  for (let i = 15; i >= 0; i -= 1) {
    randChars[i] = ALPHABET[Number(rand & 31n)] ?? "0";
    rand >>= 5n;
  }
  return timeChars.join("") + randChars.join("");
}

export function createOperationId(timestamp = Date.now()): string {
  return `op_${ulid(timestamp)}`;
}

export function createAccountId(): string {
  return `acct_${randomBytes(16).toString("base64url")}`;
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}
