import { z } from "zod";

import {
  type ChannelAddress,
  ChannelAddressSchema,
  channelKey,
} from "./channel";

export const MAX_RECENT_USER_TEXT = 5;
export const MAX_RECENT_ASSISTANT_TEXT = 3;
export const SESSION_SNIPPET_MAX_LENGTH = 160;
export const MAX_SESSION_LIMIT = 50;
export const DEFAULT_SESSION_LIST_LIMIT = 10;
export const DEFAULT_SESSION_SEARCH_LIMIT = 10;

const WHITESPACE_PATTERN = /\s+/u;

export const SessionIndexRecordSchema = z
  .object({
    channelId: z.string(),
    channelKind: ChannelAddressSchema.shape.kind,
    conversationKey: z.string(),
    lastSeenAt: z.number(),
    recentAssistantText: z.array(z.string()).readonly(),
    recentUserText: z.array(z.string()).readonly(),
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
  readonly userText: string;
}

export interface SessionListOptions {
  readonly excludeKey?: string;
  readonly limit?: number;
}

export interface SessionSearchOptions {
  readonly excludeKey?: string;
  readonly limit?: number;
}

export interface SessionIndexStore {
  list(options?: SessionListOptions): Promise<readonly SessionSummary[]>;
  search(
    query: string,
    options?: SessionSearchOptions
  ): Promise<readonly SessionSearchResult[]>;
  upsert(update: SessionTurnUpdate): Promise<void>;
}

export type SessionIndexReader = Pick<SessionIndexStore, "list" | "search">;

export interface SessionIndexRepository {
  all(): Promise<readonly SessionIndexRecord[]>;
  get(key: string): Promise<SessionIndexRecord | undefined>;
  put(record: SessionIndexRecord): Promise<void>;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

export function tokenizeSearchText(normalized: string): readonly string[] {
  return normalized.split(WHITESPACE_PATTERN).filter(Boolean);
}

export function mergeSessionRecord(
  existing: SessionIndexRecord | undefined,
  update: SessionTurnUpdate,
  conversationKey: string
): SessionIndexRecord {
  const now = update.now ?? Date.now();
  const userText = update.userText.trim();
  const assistantText = (update.assistantText ?? [])
    .map((text) => text.trim())
    .filter(Boolean);

  return {
    channelId: update.channel.id,
    channelKind: update.channel.kind,
    conversationKey,
    lastSeenAt: Math.max(existing?.lastSeenAt ?? 0, now),
    recentAssistantText: appendRecent(
      existing?.recentAssistantText ?? [],
      assistantText,
      MAX_RECENT_ASSISTANT_TEXT
    ),
    recentUserText: appendRecent(
      existing?.recentUserText ?? [],
      userText ? [userText] : [],
      MAX_RECENT_USER_TEXT
    ),
    turnCount: (existing?.turnCount ?? 0) + 1,
  };
}

export function scoreSessionRecord(
  record: SessionIndexRecord,
  tokens: readonly string[],
  normalizedQuery: string
): number {
  if (!normalizedQuery) {
    return 0;
  }

  const userHay = normalizeSearchText(record.recentUserText.join(" "));
  const assistantHay = normalizeSearchText(
    record.recentAssistantText.join(" ")
  );
  const channelHay = normalizeSearchText(record.conversationKey);

  let score = 0;
  for (const token of tokens) {
    if (userHay.includes(token)) {
      score += 3;
    }
    if (channelHay.includes(token)) {
      score += 2;
    }
    if (assistantHay.includes(token)) {
      score += 1;
    }
  }

  if (userHay.includes(normalizedQuery)) {
    score += 4;
  }
  if (assistantHay.includes(normalizedQuery)) {
    score += 1;
  }

  return score;
}

export function summarizeSessionRecord(
  record: SessionIndexRecord
): SessionSummary {
  return {
    channel: { id: record.channelId, kind: record.channelKind },
    conversationKey: record.conversationKey,
    lastSeenAt: record.lastSeenAt,
    snippet: buildSessionSnippet(record),
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
    list: async (options = {}) => {
      const records = excludeConversation(
        await repository.all(),
        options.excludeKey
      );
      return records
        .slice()
        .sort(byRecency)
        .slice(0, clampSessionLimit(options.limit, DEFAULT_SESSION_LIST_LIMIT))
        .map(summarizeSessionRecord);
    },
    search: async (query, options = {}) => {
      const normalizedQuery = normalizeSearchText(query);
      if (!normalizedQuery) {
        return [];
      }
      const tokens = tokenizeSearchText(normalizedQuery);
      const records = excludeConversation(
        await repository.all(),
        options.excludeKey
      );
      return records
        .map((record) => ({
          record,
          score: scoreSessionRecord(record, tokens, normalizedQuery),
        }))
        .filter((entry) => entry.score > 0)
        .sort(byScoreThenRecency)
        .slice(
          0,
          clampSessionLimit(options.limit, DEFAULT_SESSION_SEARCH_LIMIT)
        )
        .map((entry) => ({
          ...summarizeSessionRecord(entry.record),
          score: entry.score,
        }));
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

function appendRecent(
  existing: readonly string[],
  additions: readonly string[],
  max: number
): readonly string[] {
  const next = [...existing];
  for (const addition of additions) {
    if (next.at(-1) !== addition) {
      next.push(addition);
    }
  }
  return next.slice(-max);
}

function buildSessionSnippet(record: SessionIndexRecord): string {
  const source =
    record.recentUserText.at(-1) ?? record.recentAssistantText.at(-1) ?? "";
  const collapsed = source.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= SESSION_SNIPPET_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, SESSION_SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

function excludeConversation(
  records: readonly SessionIndexRecord[],
  excludeKey: string | undefined
): readonly SessionIndexRecord[] {
  if (!excludeKey) {
    return records;
  }
  return records.filter((record) => record.conversationKey !== excludeKey);
}

function byRecency(
  left: SessionIndexRecord,
  right: SessionIndexRecord
): number {
  return (
    right.lastSeenAt - left.lastSeenAt ||
    left.conversationKey.localeCompare(right.conversationKey)
  );
}

function byScoreThenRecency(
  left: { readonly record: SessionIndexRecord; readonly score: number },
  right: { readonly record: SessionIndexRecord; readonly score: number }
): number {
  return right.score - left.score || byRecency(left.record, right.record);
}
