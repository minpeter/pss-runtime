export function messageContentText(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [JSON.stringify(content)];
  }

  return content.flatMap((part) => {
    if (typeof part === "string") {
      return [part];
    }
    if (isObjectRecord(part) && typeof part.text === "string") {
      return [part.text];
    }
    return [];
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
