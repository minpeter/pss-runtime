import { z } from "zod";

import {
  type ChannelAddress,
  ChannelAddressSchema,
  channelKey,
} from "./channel";
import {
  buildSessionSnippet,
  byRecency,
  byScoreThenRecency,
  filterSessionRecords,
  isSessionRecordVisible,
  mergeSessionRecord,
} from "./session-index-record";
import {
  normalizeSearchText,
  scoreSessionRecord,
  tokenizeSearchText,
} from "./session-index-search";

export const MAX_SESSION_LIMIT = 50;
export const DEFAULT_SESSION_LIST_LIMIT = 10;
export const DEFAULT_SESSION_SEARCH_LIMIT = 10;

export const SessionIndexRecordSchema = z
  .object({
    channelId: z.string(),
    channelKind: ChannelAddressSchema.shape.kind,
    conversationKey: z.string(),
    lastSeenAt: z.number(),
    recentAssistantText: z.array(z.string()).readonly(),
    recentUserText: z.array(z.string()).readonly(),
    sessionScopeKey: z.string().optional(),
    threadKey: z.string().optional(),
    turnCount: z.number().int().nonnegative(),
  })
  .strict();

export type SessionIndexRecord = z.infer<typeof SessionIndexRecordSchema>;

export const SessionSummarySchema = z
  .object({
    channel: ChannelAddressSchema,
    conversationKey: z.string(),
    lastSeenAt: z.number(),
    snippet: z.string(),
    threadKey: z.string(),
    turnCount: z.number().int().nonnegative(),
  })
  .strict();

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionSearchResultSchema = SessionSummarySchema.extend({
  score: z.number(),
}).strict();

export type SessionSearchResult = z.infer<typeof SessionSearchResultSchema>;

export interface SessionTurnUpdate {
  readonly assistantText?: readonly string[];
  readonly channel: ChannelAddress;
  readonly now?: number;
  readonly sessionScopeKey?: string;
  readonly threadKey: string;
  readonly userText: string;
}

export interface SessionListOptions {
  readonly excludeKey?: string;
  readonly limit?: number;
  readonly sessionScopeKey?: string;
}

export interface SessionSearchOptions {
  readonly excludeKey?: string;
  readonly limit?: number;
  readonly sessionScopeKey?: string;
}

export interface SessionReadAuthorizationOptions {
  readonly excludeKey?: string;
  readonly sessionScopeKey?: string;
}

export interface SessionIndexStore {
  canRead(
    conversationKey: string,
    options?: SessionReadAuthorizationOptions
  ): Promise<boolean>;
  list(options?: SessionListOptions): Promise<readonly SessionSummary[]>;
  resolveThreadKey(conversationKey: string): Promise<string | undefined>;
  search(
    query: string,
    options?: SessionSearchOptions
  ): Promise<readonly SessionSearchResult[]>;
  upsert(update: SessionTurnUpdate): Promise<void>;
}

export type SessionIndexReader = Pick<
  SessionIndexStore,
  "canRead" | "list" | "search"
>;

export interface SessionIndexRepository {
  all(): Promise<readonly SessionIndexRecord[]>;
  get(key: string): Promise<SessionIndexRecord | undefined>;
  put(record: SessionIndexRecord): Promise<void>;
}

export function summarizeSessionRecord(
  record: SessionIndexRecord
): SessionSummary | null {
  if (!record.threadKey) {
    return null;
  }
  return {
    channel: { id: record.channelId, kind: record.channelKind },
    conversationKey: record.conversationKey,
    lastSeenAt: record.lastSeenAt,
    snippet: buildSessionSnippet(record),
    threadKey: record.threadKey,
    turnCount: record.turnCount,
  };
}

export function clampSessionLimit(
  limit: number | undefined,
  fallback: number
): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  const floored = Math.floor(limit);
  if (floored < 1) {
    return 1;
  }
  if (floored > MAX_SESSION_LIMIT) {
    return MAX_SESSION_LIMIT;
  }
  return floored;
}

export function createSessionIndexStore(
  repository: SessionIndexRepository
): SessionIndexStore {
  return {
    canRead: async (conversationKey, options = {}) => {
      const record = await repository.get(conversationKey);
      return record ? isSessionRecordVisible(record, options) : false;
    },
    list: async (options = {}) => {
      const records = filterSessionRecords(await repository.all(), options);
      return records
        .slice()
        .sort(byRecency)
        .flatMap((record) => {
          const summary = summarizeSessionRecord(record);
          return summary ? [summary] : [];
        })
        .slice(0, clampSessionLimit(options.limit, DEFAULT_SESSION_LIST_LIMIT));
    },
    resolveThreadKey: async (conversationKey) => {
      const record = await repository.get(conversationKey);
      return record?.threadKey;
    },
    search: async (query, options = {}) => {
      const normalizedQuery = normalizeSearchText(query);
      if (!normalizedQuery) {
        return [];
      }
      const tokens = tokenizeSearchText(normalizedQuery);
      const records = filterSessionRecords(await repository.all(), options);
      return records
        .map((record) => ({
          record,
          score: scoreSessionRecord(record, tokens, normalizedQuery),
        }))
        .filter((entry) => entry.score > 0)
        .sort(byScoreThenRecency)
        .flatMap((entry) => {
          const summary = summarizeSessionRecord(entry.record);
          return summary ? [{ ...summary, score: entry.score }] : [];
        })
        .slice(
          0,
          clampSessionLimit(options.limit, DEFAULT_SESSION_SEARCH_LIMIT)
        );
    },
    upsert: async (update) => {
      const conversationKey = channelKey(update.channel);
      const existing = await repository.get(conversationKey);
      await repository.put(
        mergeSessionRecord(existing, update, conversationKey)
      );
    },
  };
}

export function createMemorySessionIndexRepository(): SessionIndexRepository {
  const records = new Map<string, SessionIndexRecord>();
  return {
    all: () => Promise.resolve([...records.values()]),
    get: (key) => Promise.resolve(records.get(key)),
    put: (record) => {
      records.set(record.conversationKey, record);
      return Promise.resolve();
    },
  };
}
