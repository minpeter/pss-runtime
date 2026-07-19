import { z } from "zod";

const SERIALIZED_CURSOR_PATTERN = /^(0|[1-9]\d*)$/u;

declare const serializedThreadEventCursorBrand: unique symbol;

/** Transport cursor for durable, thread-scoped event replay. */
export interface ThreadEventCursor {
  readonly offset: number;
}

/** Canonical URL/SSE representation of a thread event cursor. */
export type SerializedThreadEventCursor = string & {
  readonly [serializedThreadEventCursorBrand]: true;
};

export const ThreadEventCursorSchema = z
  .object({ offset: z.number().int().nonnegative().safe() })
  .strict();

export function serializeThreadEventCursor(
  cursor: ThreadEventCursor
): SerializedThreadEventCursor {
  const parsed = ThreadEventCursorSchema.parse(cursor);
  return String(parsed.offset) as SerializedThreadEventCursor;
}

export function parseThreadEventCursor(serialized: string): ThreadEventCursor {
  if (!SERIALIZED_CURSOR_PATTERN.test(serialized)) {
    throw new InvalidThreadEventCursorError();
  }

  const offset = Number(serialized);
  if (!Number.isSafeInteger(offset)) {
    throw new InvalidThreadEventCursorError();
  }
  return { offset };
}

export class InvalidThreadEventCursorError extends Error {
  constructor() {
    super("invalid thread event cursor");
    this.name = "InvalidThreadEventCursorError";
  }
}
