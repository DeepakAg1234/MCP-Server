import { GoogleApiError } from "../domain/errors.js";
import { errorFromResponse } from "./errors.js";
import { googleApiBase } from "./origin.js";

function sendUrl(): string {
  return `${googleApiBase("https://gmail.googleapis.com")}/gmail/v1/users/me/messages/send`;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function isPreSendNetworkError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH";
}

export class GmailClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly maxExtraAttempts: number,
    private readonly timeoutMs: number,
    private readonly clock: () => Date,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async send(accessToken: string, raw: string, threadId?: string): Promise<{ messageId: string; threadId?: string }> {
    const payload = JSON.stringify(threadId ? { raw, threadId } : { raw });
    const attempts = 1 + this.maxExtraAttempts;
    let lastError: GoogleApiError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.request(accessToken, payload);
        if (response.ok) {
          const json = (await response.json()) as { id?: string; threadId?: string };
          if (!json.id) {
            throw new GoogleApiError({
              code: "UPSTREAM_ERROR",
              message: "Gmail did not return a message id.",
              ambiguous: true,
            });
          }
          return { messageId: json.id, threadId: json.threadId };
        }
        const error = await errorFromResponse(response, this.clock().getTime());
        const retryableStatus = error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus === 503;
        if (retryableStatus && error.retryAfterSeconds !== undefined && attempt < attempts) {
          await this.sleep(error.retryAfterSeconds * 1000);
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof GoogleApiError) {
          lastError = error;
          throw error;
        }
        if (isAbort(error)) {
          throw new GoogleApiError({
            code: "UPSTREAM_UNAVAILABLE",
            message: "The Gmail send request timed out after it may have been accepted.",
            retryable: false,
            ambiguous: true,
          });
        }
        if (isPreSendNetworkError(error) && attempt < attempts) {
          await this.sleep(50 * attempt);
          continue;
        }
        if (isPreSendNetworkError(error)) {
          throw new GoogleApiError({
            code: "UPSTREAM_UNAVAILABLE",
            message: "Could not connect to Gmail before the request was sent.",
            retryable: true,
          });
        }
        throw new GoogleApiError({
          code: "UPSTREAM_UNAVAILABLE",
          message: "The Gmail request failed without a response.",
          retryable: false,
          ambiguous: true,
        });
      }
    }

    throw lastError ?? new GoogleApiError({ code: "UPSTREAM_ERROR", message: "Gmail request failed.", ambiguous: true });
  }

  private request(accessToken: string, body: string): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    return this.fetchImpl(sendUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body,
      signal,
    });
  }
}
