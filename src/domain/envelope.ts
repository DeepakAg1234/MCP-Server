import type { ErrorCode } from "./errors.js";
import { defaultRetryable } from "./errors.js";

export type Warning = {
  code: string;
  message: string;
};

export type ToolError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  error_id: string;
  next_action?: string;
  retry_after_seconds?: number;
};

export type SuccessEnvelope<T> = {
  ok: true;
  operation_id: string;
  tool: string;
  result: T;
  warnings: Warning[];
};

export type FailureEnvelope = {
  ok: false;
  operation_id: string;
  tool: string;
  error: ToolError;
};

export type Envelope<T = Record<string, unknown>> = SuccessEnvelope<T> | FailureEnvelope;

export const WARNING = {
  deliveryNotGuaranteed: {
    code: "DELIVERY_NOT_GUARANTEED",
    message:
      "Gmail accepted the message for sending. This server cannot confirm that a recipient's mailbox accepted it.",
  },
  htmlSanitized: {
    code: "HTML_SANITIZED",
    message: "The HTML body was sanitized before sending. Script and unsafe URLs were removed.",
  },
  idempotencyReplay: {
    code: "IDEMPOTENCY_REPLAY",
    message: "Returned the stored result for this idempotency key. The provider was not called again.",
  },
  idempotencyKeyMissing: {
    code: "IDEMPOTENCY_KEY_MISSING",
    message: "No idempotency key was provided. A retry of this call may repeat the action.",
  },
} as const;

export function success<T>(tool: string, operationId: string, result: T, warnings: Warning[] = []): SuccessEnvelope<T> {
  return {
    ok: true,
    operation_id: operationId,
    tool,
    result,
    warnings,
  };
}

export function failure(input: {
  tool: string;
  operationId: string;
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  nextAction?: string;
  retryAfterSeconds?: number;
}): FailureEnvelope {
  const retryable = input.retryable ?? defaultRetryable(input.code);
  const error: ToolError = {
    code: input.code,
    message: input.message,
    retryable,
    error_id: input.operationId,
  };
  if (input.nextAction) {
    error.next_action = input.nextAction;
  }
  if (input.retryAfterSeconds !== undefined) {
    error.retry_after_seconds = input.retryAfterSeconds;
  } else if (input.code === "RATE_LIMITED") {
    error.retry_after_seconds = 60;
  }
  return {
    ok: false,
    operation_id: input.operationId,
    tool: input.tool,
    error,
  };
}

export function withReplayWarning<T>(envelope: SuccessEnvelope<T>): SuccessEnvelope<T> {
  if (envelope.warnings.some((warning) => warning.code === WARNING.idempotencyReplay.code)) {
    return envelope;
  }
  return {
    ...envelope,
    warnings: [...envelope.warnings, WARNING.idempotencyReplay],
  };
}
