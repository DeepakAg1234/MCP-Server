export const TOKEN_URL = "https://oauth2.googleapis.com/token";

function configuredOrigin(): string | undefined {
  const value = process.env.GOOGLE_API_ORIGIN?.trim();
  if (!value) return undefined;
  return value.replace(/\/+$/, "");
}

/** Production host, unless the contract harness sets GOOGLE_API_ORIGIN. */
export function googleApiBase(production: string): string {
  return configuredOrigin() ?? production;
}

export function tokenEndpoint(): string {
  const override = configuredOrigin();
  return override ? `${override}/token` : TOKEN_URL;
}
