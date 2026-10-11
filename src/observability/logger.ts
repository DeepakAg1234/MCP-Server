import type { LogLevel } from "../config/env.js";
import { redact } from "../policy/redaction.js";

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type Logger = {
  debug(msg: string, fields?: Record<string, unknown>): string;
  info(msg: string, fields?: Record<string, unknown>): string;
  warn(msg: string, fields?: Record<string, unknown>): string;
  error(msg: string, fields?: Record<string, unknown>): string;
  addSecret(secret: string): void;
};

export function createLogger(options: {
  level: LogLevel;
  logContent: boolean;
  secrets?: string[];
  write?: (line: string) => void;
  now?: () => Date;
}): Logger {
  const secrets = [...(options.secrets ?? [])];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): string {
    if (RANK[level] < RANK[options.level]) return "";
    const payload = redact(
      {
        time: now().toISOString(),
        level,
        msg,
        ...fields,
      },
      { logContent: options.logContent, secrets },
    );
    const line = JSON.stringify(payload);
    write(line);
    return line;
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    addSecret(secret: string) {
      if (secret.length >= 4) secrets.push(secret);
    },
  };
}
