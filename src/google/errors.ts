import { GoogleApiError, type ErrorCode } from "../domain/errors.js";

type GoogleBody = {
  error?: {
    status?: string;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
};

function normalizeReason(value: string): string {
  return value.toLowerCase().replace(/[_-]/g, "");
}

function reasons(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return [normalizeReason(error)];
  if (!error || typeof error !== "object") return [];
  const record = error as GoogleBody["error"];
  const status = record?.status ? normalizeReason(record.status) : "";
  const nested = (record?.errors ?? []).map((item) => normalizeReason(item.reason ?? ""));
  return [status, ...nested].filter((value) => value.length > 0);
}

function isScopeProblem(reasonList: readonly string[]): boolean {
  return reasonList.some((reason) =>
    reason.includes("insufficient") ||
    reason.includes("accessnotconfigured") ||
    reason.includes("scope"),
  );
}

function isRevisionConflict(reasonList: readonly string[]): boolean {
  return reasonList.some((reason) =>
    reason.includes("failedprecondition") ||
    reason.includes("revision") ||
    reason.includes("conditionnotmet") ||
    reason.includes("conflict"),
  );
}

export function translateGoogleError(status: number, body: unknown, retryAfterSeconds?: number): GoogleApiError {
  const reasonList = reasons(body);
  let code: ErrorCode = "UPSTREAM_ERROR";
  let retryable = false;
  let ambiguous = false;
  let message = "The Google API request failed.";

  if (status === 401 || reasonList.some((reason) => reason.includes("invalidgrant"))) {
    code = "UNAUTHENTICATED";
    message = "The Google account authorization is no longer valid.";
  } else if (status === 403 && isScopeProblem(reasonList)) {
    code = "INSUFFICIENT_SCOPE";
    message = "The selected account is not authorized for this action.";
  } else if (status === 403) {
    code = "ACCESS_DENIED";
    message = "Google refused the request for this account.";
  } else if (status === 404) {
    code = "NOT_FOUND";
    message = "Google could not find the requested resource.";
  } else if (status === 409 || isRevisionConflict(reasonList)) {
    code = "CONFLICT";
    message = "The document changed before the append could be applied.";
    retryable = false;
  } else if (status === 429) {
    code = "RATE_LIMITED";
    message = "Google rate-limited the request.";
    retryable = true;
  } else if (status === 408 || status === 500 || status === 502 || status === 503) {
    code = "UPSTREAM_UNAVAILABLE";
    message = "Google did not accept the request cleanly.";
    retryable = true;
    ambiguous = status === 500 || status === 502 || status === 503 || status === 408;
  } else if (status === 400) {
    code = "INVALID_ARGUMENT";
    message = "Google rejected the request as invalid.";
  } else if (status >= 500) {
    code = "UPSTREAM_ERROR";
    message = "Google returned an unexpected server error.";
    ambiguous = true;
  } else if (status >= 400) {
    code = "UPSTREAM_ERROR";
    message = "Google rejected the request.";
  }

  return new GoogleApiError({
    code,
    message,
    retryable,
    retryAfterSeconds: code === "RATE_LIMITED" ? (retryAfterSeconds ?? 60) : retryAfterSeconds,
    ambiguous,
    httpStatus: status,
  });
}

export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0 && /^\d+(\.\d+)?$/.test(header.trim())) {
    return Math.ceil(seconds);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - nowMs) / 1000));
}

export async function errorFromResponse(response: Response, nowMs: number): Promise<GoogleApiError> {
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  return translateGoogleError(response.status, body, retryAfter);
}
