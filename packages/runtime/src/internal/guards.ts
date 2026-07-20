export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected variant: ${String(value)}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
