import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ConfigError } from "../domain/errors.js";

export class TokenCipher {
  constructor(
    private readonly key: Buffer,
    readonly keyVersion = 1,
  ) {
    if (key.length !== 32) {
      throw new ConfigError("TOKEN_ENCRYPTION_KEY must decode to 32 bytes.");
    }
  }

  encrypt(plaintext: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([1, this.keyVersion]), nonce, tag, ciphertext]);
  }

  decrypt(blob: Uint8Array): string {
    const buffer = Buffer.from(blob);
    if (buffer.length < 31 || buffer[0] !== 1) {
      throw new Error("Refresh token ciphertext is unreadable.");
    }
    const nonce = buffer.subarray(2, 14);
    const tag = buffer.subarray(14, 30);
    const ciphertext = buffer.subarray(30);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

export function encryptionKeyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new ConfigError("TOKEN_ENCRYPTION_KEY must decode to 32 bytes.");
  }
  return key;
}
