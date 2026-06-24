import type { AgentOptions } from "@minpeter/pss-runtime";
import { z } from "zod";

import {
  DEFAULT_SESSION_LIST_LIMIT,
  DEFAULT_SESSION_SEARCH_LIMIT,
  MAX_SESSION_LIMIT,
  type SessionIndexReader,
  type SessionSearchResult,
  type SessionSummary,
} from "./session-index";

export const LIST_SESSIONS_TOOL_NAME = "list_sessions";
export const SEARCH_SESSIONS_TOOL_NAME = "search_sessions";

const ListSessionsToolInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SESSION_LIMIT)
      .optional()
      .describe("Maximum number of recent sessions to return."),
  })
  .strict();

const SearchSessionsToolInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SESSION_LIMIT)
      .optional()
      .describe("Maximum number of matching sessions to return."),
    query: z
      .string()
      .min(1)
      .describe("Words to look for across other conversation transcripts."),
  })
  .strict();

export interface SessionToolEntry {
  readonly channel: SessionSummary["channel"];
  readonly conversationKey: string;
  readonly lastSeenAt: number;
  readonly snippet: string;
  readonly turnCount: number;
}

export interface ListSessionsToolResult {
  readonly sessions: readonly SessionToolEntry[];
}

export interface SearchSessionsToolEntry extends SessionToolEntry {
  readonly score: number;
}

export interface SearchSessionsToolResult {
  readonly query: string;
  readonly sessions: readonly SearchSessionsToolEntry[];
}

export interface WorkerAgentSessionToolOptions {
  readonly currentConversationKey: () => string | undefined;
  readonly reader: SessionIndexReader;
}

type WorkerAgentToolSet = NonNullable<AgentOptions["tools"]>;

export function createSessionTools(
  options: WorkerAgentSessionToolOptions
): WorkerAgentToolSet {
  return {
    [LIST_SESSIONS_TOOL_NAME]: {
      description:
        "List other recent conversations (across messaging surfaces) with a short snippet. Use this to recall what you discussed elsewhere instead of guessing.",
      execute: async (input: unknown): Promise<ListSessionsToolResult> => {
        const parsed = ListSessionsToolInputSchema.parse(input);
        const summaries = await options.reader.list({
          limit: parsed.limit ?? DEFAULT_SESSION_LIST_LIMIT,
          ...excludeCurrent(options),
        });
        return { sessions: summaries.map(toToolEntry) };
      },
      inputSchema: ListSessionsToolInputSchema,
    },
    [SEARCH_SESSIONS_TOOL_NAME]: {
      description:
        "Search other recent conversations by keyword and return matching snippets. Use this to find what you actually said in another chat before claiming you remember it.",
      execute: async (input: unknown): Promise<SearchSessionsToolResult> => {
        const parsed = SearchSessionsToolInputSchema.parse(input);
        const query = parsed.query.trim();
        const results = await options.reader.search(query, {
          limit: parsed.limit ?? DEFAULT_SESSION_SEARCH_LIMIT,
          ...excludeCurrent(options),
        });
        return { query, sessions: results.map(toSearchEntry) };
      },
      inputSchema: SearchSessionsToolInputSchema,
    },
  };
}

function excludeCurrent(options: WorkerAgentSessionToolOptions): {
  readonly excludeKey?: string;
} {
  const current = options.currentConversationKey();
  return current ? { excludeKey: current } : {};
}

function toToolEntry(summary: SessionSummary): SessionToolEntry {
  return {
    channel: summary.channel,
    conversationKey: summary.conversationKey,
    lastSeenAt: summary.lastSeenAt,
    snippet: summary.snippet,
    turnCount: summary.turnCount,
  };
}

function toSearchEntry(result: SessionSearchResult): SearchSessionsToolEntry {
  return {
    ...toToolEntry(result),
    score: result.score,
  };
}
