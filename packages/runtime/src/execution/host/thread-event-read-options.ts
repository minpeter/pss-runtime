import type { ThreadEventReadOptions } from "./types";

export interface NormalizedThreadEventReadOptions {
  readonly limit?: number;
  readonly start: number;
}

export function normalizeThreadEventReadOptions(
  options: ThreadEventReadOptions = {}
): NormalizedThreadEventReadOptions {
  return {
    limit: normalizeLimit(options.limit),
    start: normalizeOffset(options.after?.offset, "cursor offset"),
  };
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return;
  }
  return normalizeOffset(limit, "limit");
}

function normalizeOffset(value: number | undefined, label: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `thread event ${label} must be a non-negative integer.`
    );
  }
  return value;
}
