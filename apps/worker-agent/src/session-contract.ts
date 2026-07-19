import type {
  AgentEvent,
  StoredThreadEvent as RuntimeStoredThreadEvent,
  ThreadEventCursor as RuntimeThreadEventCursor,
} from "@minpeter/pss-runtime";
import { z } from "zod";

import {
  type ChannelAddress,
  ChannelAddressSchema,
  channelKey,
} from "./channel";

const SERIALIZED_CURSOR_PATTERN = /^(0|[1-9]\d*)$/u;
const SESSION_REPLAY_MAX_LIMIT = 100;

declare const serializedThreadEventCursorBrand: unique symbol;

/** Transport cursor for durable, thread-scoped event replay. */
export type ThreadEventCursor = RuntimeThreadEventCursor;

/** Canonical URL/SSE representation of a thread event cursor. */
export type SerializedThreadEventCursor = string & {
  readonly [serializedThreadEventCursorBrand]: true;
};

export type StoredThreadEvent = RuntimeStoredThreadEvent;

export interface SubmitTurnRequest {
  readonly channel: ChannelAddress;
  readonly idempotencyKey?: string;
  readonly sessionScopeKey?: string;
  readonly text: string;
}

export interface SubmitTurnResponse {
  readonly accepted: true;
  readonly eventCursor?: ThreadEventCursor;
  readonly runId: string;
  readonly threadKey: string;
}

export interface ReplayEventsRequest {
  readonly after?: ThreadEventCursor;
  readonly channel: ChannelAddress;
  readonly limit?: number;
  readonly sessionScopeKey?: string;
}

export interface ReplayEventsResponse {
  readonly events: readonly StoredThreadEvent[];
  readonly nextCursor?: ThreadEventCursor;
}

export const ThreadEventCursorSchema = z
  .object({ offset: z.number().int().nonnegative().safe() })
  .strict();

export const SubmitTurnRequestSchema = z
  .object({
    channel: ChannelAddressSchema,
    idempotencyKey: z.string().optional(),
    sessionScopeKey: z.string().optional(),
    text: z.string(),
  })
  .strict();

export const SubmitTurnResponseSchema = z
  .object({
    accepted: z.literal(true),
    eventCursor: ThreadEventCursorSchema.optional(),
    runId: z.string().min(1),
    threadKey: z.string().min(1),
  })
  .strict();

export const ReplayEventsRequestSchema = z
  .object({
    after: ThreadEventCursorSchema.optional(),
    channel: ChannelAddressSchema,
    limit: z.number().int().positive().max(SESSION_REPLAY_MAX_LIMIT).optional(),
    sessionScopeKey: z.string().optional(),
  })
  .strict();

export const ReplayEventsResponseSchema = z.custom<ReplayEventsResponse>(
  isReplayEventsResponse
);

function isReplayEventsResponse(value: unknown): value is ReplayEventsResponse {
  if (!(typeof value === "object" && value !== null && "events" in value)) {
    return false;
  }
  if (
    !(Array.isArray(value.events) && value.events.every(isStoredThreadEvent))
  ) {
    return false;
  }
  return (
    !("nextCursor" in value) ||
    value.nextCursor === undefined ||
    ThreadEventCursorSchema.safeParse(value.nextCursor).success
  );
}

function isStoredThreadEvent(value: unknown): value is StoredThreadEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "cursor" in value &&
    ThreadEventCursorSchema.safeParse(value.cursor).success &&
    "event" in value &&
    isAgentEvent(value.event) &&
    "threadKey" in value &&
    typeof value.threadKey === "string"
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

export function serializeSessionChannel(channel: ChannelAddress): string {
  return channelKey(channel);
}

export function parseSessionChannel(serialized: string): ChannelAddress {
  const separator = serialized.indexOf(":");
  if (separator < 1) {
    throw new InvalidSessionChannelError();
  }
  const parsed = ChannelAddressSchema.safeParse({
    id: serialized.slice(separator + 1),
    kind: serialized.slice(0, separator),
  });
  if (!(parsed.success && parsed.data.id.trim())) {
    throw new InvalidSessionChannelError();
  }
  return { id: parsed.data.id.trim(), kind: parsed.data.kind };
}

export class InvalidSessionChannelError extends Error {
  constructor() {
    super("invalid session channel");
    this.name = "InvalidSessionChannelError";
  }
}

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
