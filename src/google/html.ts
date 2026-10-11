const BLOCKED_TAGS = ["script", "iframe", "object", "embed", "form"];

function stripBlockedElements(html: string): string {
  let next = html;
  for (const tag of BLOCKED_TAGS) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    next = next.replace(paired, "");
    const orphan = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    next = next.replace(orphan, "");
  }
  return next;
}

function stripEventHandlers(html: string): string {
  return html.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function stripUnsafeUrls(html: string): string {
  return html.replace(
    /(\s(?:href|src|action|formaction|xlink:href)\s*=\s*)(["'])\s*(?:javascript|data):[^"']*\2/gi,
    '$1$2#$2',
  ).replace(
    /(\s(?:href|src|action|formaction)\s*=\s*)(?:javascript|data):[^\s>]+/gi,
    "$1\"#\"",
  );
}

export function sanitizeHtml(html: string): { html: string; changed: boolean } {
  const next = stripUnsafeUrls(stripEventHandlers(stripBlockedElements(html)));
  return { html: next, changed: next !== html };
}
