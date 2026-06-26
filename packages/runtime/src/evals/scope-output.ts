export function parseReply(
  reply: string
): { ok: true; value: unknown } | { ok: false } {
  if (reply.length === 0) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(reply) };
  } catch {
    return { ok: false };
  }
}

export function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

export function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

export function outputEqualsFailure(parsedOk: boolean): string | undefined {
  return parsedOk ? "parsed reply did not equal expected" : "reply was not JSON";
}
