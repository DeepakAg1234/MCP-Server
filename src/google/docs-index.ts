export type AppendPlan = {
  insertIndex: number;
  text: string;
  startIndex: number;
  endIndex: number;
};

/**
 * Google Docs indexes are UTF-16 code units. JavaScript string length uses the same unit.
 * The insert index is the last structural endIndex minus 1, before the required trailing newline.
 * An empty document (endIndex <= 2) is not prefixed with a newline.
 */
export function planDocsAppend(documentEndIndex: number, content: string, prependNewline: boolean): AppendPlan {
  if (!Number.isInteger(documentEndIndex) || documentEndIndex < 1) {
    throw new Error("document endIndex is missing");
  }
  const insertIndex = documentEndIndex - 1;
  const text = prependNewline && documentEndIndex > 2 ? `\n${content}` : content;
  return {
    insertIndex,
    text,
    startIndex: insertIndex,
    endIndex: insertIndex + text.length,
  };
}

export function lastEndIndex(content: unknown): number | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const last = content[content.length - 1] as { endIndex?: unknown };
  return typeof last?.endIndex === "number" ? last.endIndex : undefined;
}
