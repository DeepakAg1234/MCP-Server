export const TOOL = {
  listAccounts: "google_list_accounts",
  authorizationStatus: "google_authorization_status",
  beginAuthorization: "google_begin_authorization",
  sendEmail: "gmail_send_email",
  appendContent: "gdocs_append_content",
} as const;

export type ToolName = (typeof TOOL)[keyof typeof TOOL];

export const TOOL_ORDER: readonly ToolName[] = [
  TOOL.listAccounts,
  TOOL.authorizationStatus,
  TOOL.beginAuthorization,
  TOOL.sendEmail,
  TOOL.appendContent,
];

export const CAPABILITIES = ["gmail.send", "docs.append"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type StatusCapability = Capability | "all";

export const SCOPE = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  documents: "https://www.googleapis.com/auth/documents",
} as const;

const BASE_SCOPES = [SCOPE.openid, SCOPE.email, SCOPE.profile];

export function scopesForCapabilities(capabilities: readonly Capability[], existing: readonly string[] = []): string[] {
  const scopes = new Set<string>([...BASE_SCOPES, ...existing]);
  for (const capability of capabilities) {
    if (capability === "gmail.send") scopes.add(SCOPE.gmailSend);
    if (capability === "docs.append") scopes.add(SCOPE.documents);
  }
  return [...scopes];
}

export function missingScopesFor(capability: StatusCapability, granted: readonly string[]): string[] {
  const required =
    capability === "all"
      ? [SCOPE.gmailSend, SCOPE.documents]
      : capability === "gmail.send"
        ? [SCOPE.gmailSend]
        : [SCOPE.documents];
  return required.filter((scope) => !granted.includes(scope));
}
