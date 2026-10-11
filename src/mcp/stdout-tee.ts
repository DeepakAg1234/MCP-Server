import { appendFileSync } from "node:fs";

const teePath = process.env.MCP_STDOUT_TEE;
if (teePath) {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.length > 0) appendFileSync(teePath, text);
    return original(chunk, encoding as BufferEncoding, callback);
  }) as typeof process.stdout.write;
}
