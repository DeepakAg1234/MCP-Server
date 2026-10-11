import type { App } from "../app/create-app.js";
import { listenForCallback } from "../auth/oauth-flow.js";
import type { InvocationContext } from "../domain/context.js";
import { failure, type Envelope } from "../domain/envelope.js";
import { TOOL } from "../domain/tools.js";

export async function callListAccounts(app: App, ctx: InvocationContext, input: unknown): Promise<Envelope> {
  return app.accounts.list(ctx, input ?? {});
}

export async function callAuthorizationStatus(app: App, ctx: InvocationContext, input: unknown): Promise<Envelope> {
  return app.accounts.status(ctx, input ?? {});
}

export async function callBeginAuthorization(app: App, ctx: InvocationContext, input: unknown): Promise<Envelope> {
  if (ctx.transport === "streamable-http") {
    return app.accounts.begin(ctx, input ?? {}, app.config.googleRedirectUri);
  }
  let redirectUri = "";
  const listener = await listenForCallback({
    port: app.config.oauthLoopbackPort,
    onCallback: async (query) => {
      const result = await app.oauth.finish(ctx, {
        ...(query.get("code") ? { code: query.get("code") ?? undefined } : {}),
        ...(query.get("state") ? { state: query.get("state") ?? undefined } : {}),
        ...(query.get("error") ? { error: query.get("error") ?? undefined } : {}),
        redirectUri,
      });
      return { status: result.status, html: result.html };
    },
  });
  redirectUri = `http://127.0.0.1:${listener.port}/oauth/google/callback`;
  try {
    const envelope = await app.accounts.begin(ctx, input ?? {}, redirectUri);
    if (!envelope.ok) await listener.close();
    return envelope;
  } catch {
    await listener.close();
    return failure({
      tool: TOOL.beginAuthorization,
      operationId: ctx.operationId,
      code: "INTERNAL_ERROR",
      message: "Authorization could not be started.",
    });
  }
}

export async function callSendEmail(app: App, ctx: InvocationContext, input: unknown): Promise<Envelope> {
  return app.email.send(ctx, input ?? {});
}

export async function callAppendContent(app: App, ctx: InvocationContext, input: unknown): Promise<Envelope> {
  return app.docs.append(ctx, input ?? {});
}
