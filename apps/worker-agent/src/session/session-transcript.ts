import type { ThreadStore } from "@minpeter/pss-runtime";
import { z } from "zod";

import { extractSessionTranscriptMessages } from "./session-transcript-projection";

export const DEFAULT_SESSION_READ_LIMIT = 20;
export const MAX_SESSION_READ_LIMIT = 50;

const SessionTranscriptMessageSchema = z
  .object({
    index: z.number().int().nonnegative(),
    role: z.enum(["assistant", "user"]),
    text: z.string(),
  })
  .strict();

export type SessionTranscriptMessage = z.infer<
  typeof SessionTranscriptMessageSchema
>;

export const SessionTranscriptSchema = z
  .object({
    conversationKey: z.string(),
    hasMore: z.boolean(),
    messageCount: z.number().int().nonnegative(),
    messages: z.array(SessionTranscriptMessageSchema).readonly(),
    nextCursor: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SessionTranscript = z.infer<typeof SessionTranscriptSchema>;

export interface SessionTranscriptReadOptions {
  readonly before?: number;
  readonly limit?: number;
}

export interface SessionTranscriptReader {
  read(
    conversationKey: string,
    options?: SessionTranscriptReadOptions
  ): Promise<SessionTranscript | undefined>;
}

interface ThreadStoreSessionTranscriptReaderOptions {
  readonly resolveThreadKey: (
    conversationKey: string
  ) => string | undefined | Promise<string | undefined>;
  readonly store: ThreadStore;
}

export function createThreadStoreSessionTranscriptReader({
  resolveThreadKey,
  store,
}: ThreadStoreSessionTranscriptReaderOptions): SessionTranscriptReader {
  return {
    read: async (conversationKey, options = {}) => {
      const threadKey =
        (await resolveThreadKey(conversationKey)) ?? conversationKey;
      const stored = await store.load(threadKey);
      if (!stored) {
        return;
      }
      const messages = extractSessionTranscriptMessages(stored.state);
      const limit = clampReadLimit(options.limit);
      const end = clampReadCursor(options.before, messages.length);
      const start = Math.max(0, end - limit);
      const page = messages.slice(start, end);
      const hasMore = start > 0;
      return {
        conversationKey,
        hasMore,
        messageCount: messages.length,
        messages: page,
        ...(hasMore ? { nextCursor: start } : {}),
      };
    },
  };
}

function clampReadLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SESSION_READ_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) {
    return 1;
  }
  return Math.min(floored, MAX_SESSION_READ_LIMIT);
}

function clampReadCursor(
  before: number | undefined,
  messageCount: number
): number {
  if (before === undefined || !Number.isFinite(before)) {
    return messageCount;
  }
  return Math.max(0, Math.min(Math.floor(before), messageCount));
}
