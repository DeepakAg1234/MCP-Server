export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
  "ACCOUNT_NOT_FOUND",
  "INSUFFICIENT_SCOPE",
  "ACCESS_DENIED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_ERROR",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const RETRYABLE: Record<ErrorCode, boolean> = {
  INVALID_ARGUMENT: false,
  UNAUTHENTICATED: false,
  ACCOUNT_NOT_FOUND: false,
  INSUFFICIENT_SCOPE: false,
  ACCESS_DENIED: false,
  NOT_FOUND: false,
  CONFLICT: false,
  RATE_LIMITED: true,
  UPSTREAM_UNAVAILABLE: true,
  UPSTREAM_ERROR: false,
  IDEMPOTENCY_CONFLICT: false,
  INTERNAL_ERROR: false,
};

export function defaultRetryable(code: ErrorCode): boolean {
  return RETRYABLE[code];
}

export class GoogleApiError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly ambiguous: boolean;
  readonly httpStatus?: number;

  constructor(input: {
    code: ErrorCode;
    message: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
    ambiguous?: boolean;
    httpStatus?: number;
  }) {
    super(input.message);
    this.name = "GoogleApiError";
    this.code = input.code;
    this.retryable = input.retryable ?? defaultRetryable(input.code);
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.ambiguous = input.ambiguous ?? false;
    this.httpStatus = input.httpStatus;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
