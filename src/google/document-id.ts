const RAW_ID = /^[A-Za-z0-9_-]{10,128}$/;

export function parseDocumentId(input: string): { ok: true; documentId: string } | { ok: false; message: string } {
  const value = input.trim();
  if (!value.includes("://") && !value.includes("/") && !value.includes("@")) {
    if (RAW_ID.test(value)) return { ok: true, documentId: value };
    return { ok: false, message: "document_id must be a Google Docs id or an https://docs.google.com/document/d/{id} URL" };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "document_id is not a valid document id or Docs URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "document URL must use https" };
  }
  if (url.username || url.password) {
    return { ok: false, message: "document URL must not contain userinfo" };
  }
  if (url.hostname !== "docs.google.com" || url.port !== "") {
    return { ok: false, message: "document URL host must be docs.google.com" };
  }
  const match = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]{10,128})(?:\/.*)?$/);
  if (!match?.[1]) {
    return { ok: false, message: "document URL path must be /document/d/{id}" };
  }
  return { ok: true, documentId: match[1] };
}
