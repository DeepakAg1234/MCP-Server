import type { AppConfig } from "../config/env.js";
import { GoogleApiError } from "../domain/errors.js";
import { sha256Base64Url } from "../domain/hash.js";
import type { Capability } from "../domain/tools.js";
import { parseRetryAfter, translateGoogleError } from "../google/errors.js";

import { TOKEN_URL, tokenEndpoint } from "./origin.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export { TOKEN_URL };

export type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
};

export type IdTokenClaims = {
  sub: string;
  email: string;
  name: string;
};

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scopes.join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function codeChallenge(verifier: string): string {
  return sha256Base64Url(verifier);
}

export function decodeIdToken(idToken: string): IdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new GoogleApiError({
      code: "UPSTREAM_ERROR",
      message: "Google did not return a usable identity token.",
    });
  }
  let payload: { sub?: string; email?: string; name?: string };
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      sub?: string;
      email?: string;
      name?: string;
    };
  } catch {
    throw new GoogleApiError({
      code: "UPSTREAM_ERROR",
      message: "Google did not return a usable identity token.",
    });
  }
  if (!payload.sub || !payload.email) {
    throw new GoogleApiError({
      code: "UPSTREAM_ERROR",
      message: "Google did not return the account email.",
    });
  }
  return { sub: payload.sub, email: payload.email, name: payload.name ?? "" };
}

async function postToken(
  fetchImpl: typeof fetch,
  config: Pick<AppConfig, "googleOauthClientId" | "googleOauthClientSecret">,
  body: URLSearchParams,
  nowMs: number,
): Promise<GoogleTokenResponse> {
  const response = await fetchImpl(tokenEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const raw = (await response.json().catch(() => ({}))) as {
    error?: string;
    access_token?: string;
    expires_in?: number;
  };
  if (!response.ok || !raw.access_token) {
    if (raw.error === "invalid_grant") {
      throw new GoogleApiError({
        code: "UNAUTHENTICATED",
        message: "The Google account authorization is no longer valid.",
        httpStatus: response.status,
      });
    }
    throw translateGoogleError(response.status, raw, parseRetryAfter(response.headers.get("retry-after"), nowMs));
  }
  return raw as GoogleTokenResponse;
}

export async function exchangeAuthorizationCode(input: {
  fetchImpl: typeof fetch;
  config: Pick<AppConfig, "googleOauthClientId" | "googleOauthClientSecret">;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nowMs: number;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.config.googleOauthClientId,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.codeVerifier,
  });
  if (input.config.googleOauthClientSecret) {
    body.set("client_secret", input.config.googleOauthClientSecret);
  }
  return postToken(input.fetchImpl, input.config, body, input.nowMs);
}

export async function refreshAccessToken(input: {
  fetchImpl: typeof fetch;
  config: Pick<AppConfig, "googleOauthClientId" | "googleOauthClientSecret">;
  refreshToken: string;
  nowMs: number;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    client_id: input.config.googleOauthClientId,
    grant_type: "refresh_token",
  });
  if (input.config.googleOauthClientSecret) {
    body.set("client_secret", input.config.googleOauthClientSecret);
  }
  return postToken(input.fetchImpl, input.config, body, input.nowMs);
}

export function grantedScopes(response: GoogleTokenResponse, requested: readonly Capability[] | readonly string[]): string[] {
  if (response.scope && response.scope.trim()) {
    return response.scope.split(/\s+/).filter((scope) => scope.length > 0);
  }
  return [...requested];
}
