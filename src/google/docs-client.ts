import { GoogleApiError } from "../domain/errors.js";
import { lastEndIndex, planDocsAppend } from "./docs-index.js";
import { errorFromResponse } from "./errors.js";
import { googleApiBase } from "./origin.js";

export type DocsAppendResult = {
  documentId: string;
  documentTitle: string;
  startIndex: number;
  endIndex: number;
  baseRevisionId: string;
  revisionId?: string;
};

export class DocsClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly maxAttempts: number,
    private readonly timeoutMs: number,
    private readonly clock: () => Date,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async appendText(
    accessToken: string,
    documentId: string,
    content: string,
    prependNewline: boolean,
  ): Promise<DocsAppendResult> {
    let lastConflict: GoogleApiError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const current = await this.getDocument(accessToken, documentId);
      const plan = planDocsAppend(current.endIndex, content, prependNewline);
      try {
        const revisionId = await this.insertText(accessToken, documentId, plan.insertIndex, plan.text, current.revisionId);
        const result: DocsAppendResult = {
          documentId,
          documentTitle: current.title,
          startIndex: plan.startIndex,
          endIndex: plan.endIndex,
          baseRevisionId: current.revisionId,
        };
        if (revisionId) result.revisionId = revisionId;
        return result;
      } catch (error) {
        if (error instanceof GoogleApiError && error.code === "CONFLICT" && attempt < this.maxAttempts) {
          lastConflict = error;
          await this.sleep(25 * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      }
    }
    throw (
      lastConflict ??
      new GoogleApiError({
        code: "CONFLICT",
        message: "The document changed before the append could be applied.",
        retryable: false,
      })
    );
  }

  private async getDocument(
    accessToken: string,
    documentId: string,
  ): Promise<{ revisionId: string; title: string; endIndex: number }> {
    const url = `${googleApiBase("https://docs.googleapis.com")}/v1/documents/${encodeURIComponent(documentId)}?fields=revisionId,title,body.content.endIndex`;
    const response = await this.request(url, accessToken);
    if (!response.ok) throw await errorFromResponse(response, this.clock().getTime());
    const json = (await response.json()) as {
      revisionId?: string;
      title?: string;
      body?: { content?: unknown };
    };
    const endIndex = lastEndIndex(json.body?.content);
    if (!json.revisionId || endIndex === undefined) {
      throw new GoogleApiError({
        code: "UPSTREAM_ERROR",
        message: "Google Docs did not return the document revision.",
      });
    }
    return { revisionId: json.revisionId, title: json.title ?? "", endIndex };
  }

  private async insertText(
    accessToken: string,
    documentId: string,
    index: number,
    text: string,
    requiredRevisionId: string,
  ): Promise<string | undefined> {
    const url = `${googleApiBase("https://docs.googleapis.com")}/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`;
    const response = await this.request(url, accessToken, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ insertText: { location: { index }, text } }],
        writeControl: { requiredRevisionId },
      }),
    });
    if (!response.ok) {
      const error = await errorFromResponse(response, this.clock().getTime());
      if (error.code === "CONFLICT") {
        throw new GoogleApiError({
          code: "CONFLICT",
          message: error.message,
          retryable: false,
          httpStatus: error.httpStatus,
        });
      }
      throw error;
    }
    const json = (await response.json()) as { writeControl?: { requiredRevisionId?: string }; revisionId?: string };
    return json.revisionId ?? json.writeControl?.requiredRevisionId;
  }

  private request(url: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
