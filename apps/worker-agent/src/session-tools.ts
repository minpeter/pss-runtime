import type { AgentOptions } from "@minpeter/pss-runtime";
import { z } from "zod";
import { channelKey } from "./channel";
import {
  DEFAULT_SESSION_LIST_LIMIT,
  DEFAULT_SESSION_SEARCH_LIMIT,
  MAX_SESSION_LIMIT,
  type SessionIndexReader,
  type SessionSearchResult,
  type SessionSummary,
} from "./session-index";
import {
  MAX_SESSION_READ_LIMIT,
  type SessionTranscript,
  type SessionTranscriptMessage,
  type SessionTranscriptReader,
} from "./session-transcript";

export const LIST_SESSIONS_TOOL_NAME = "list_sessions";
export const SEARCH_SESSIONS_TOOL_NAME = "search_sessions";
export const READ_SESSION_TOOL_NAME = "read_session";

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

const ReadSessionToolInputSchema = z
  .object({
    before: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Read messages before this transcript cursor when paging older context."
      ),
    channel: z
      .string()
      .min(1)
      .describe(
        "The channel value (kind:id) returned by list_sessions or search_sessions."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SESSION_READ_LIMIT)
      .optional()
      .describe("Maximum number of transcript messages to return."),
  })
  .strict();

export interface SessionToolEntry {
  readonly channel: string;
  readonly lastSeenAt: string;
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

export type ReadSessionToolResult =
  | {
      readonly channel: string;
      readonly found: false;
    }
  | {
      readonly channel: string;
      readonly found: true;
      readonly hasMore: boolean;
      readonly messageCount: number;
      readonly messages: readonly SessionTranscriptMessage[];
      readonly nextCursor?: number;
    };

export interface WorkerAgentSessionToolOptions {
  readonly currentConversationKey: () => string | undefined;
  readonly currentSessionScopeKey?: () => string | undefined;
  readonly reader: SessionIndexReader;
  readonly transcriptReader?: SessionTranscriptReader;
}

type WorkerAgentToolSet = NonNullable<AgentOptions["tools"]>;

export function createSessionTools(
  options: WorkerAgentSessionToolOptions
): WorkerAgentToolSet {
  const tools: WorkerAgentToolSet = {
    [LIST_SESSIONS_TOOL_NAME]: {
      description:
        "List other recent conversations (across messaging surfaces) with a short snippet. Use this to recall what you discussed elsewhere instead of guessing.",
      execute: async (input: unknown): Promise<ListSessionsToolResult> => {
        const parsed = ListSessionsToolInputSchema.parse(input);
        const summaries = await options.reader.list({
          limit: parsed.limit ?? DEFAULT_SESSION_LIST_LIMIT,
          ...sessionFilter(options),
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
          ...sessionFilter(options),
        });
        return { query, sessions: results.map(toSearchEntry) };
      },
      inputSchema: SearchSessionsToolInputSchema,
    },
  };

  if (options.transcriptReader) {
    tools[READ_SESSION_TOOL_NAME] = {
      description:
        "Read a capped transcript from a specific channel returned by list_sessions or search_sessions. Use this after selecting a likely prior conversation, before answering details from it.",
      execute: async (input: unknown): Promise<ReadSessionToolResult> => {
        const parsed = ReadSessionToolInputSchema.parse(input);
        const canRead = await options.reader.canRead(
          parsed.channel,
          sessionFilter(options)
        );
        if (!canRead) {
          return { channel: parsed.channel, found: false };
        }
        const transcript = await options.transcriptReader?.read(
          parsed.channel,
          {
            ...(parsed.before === undefined ? {} : { before: parsed.before }),
            ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
          }
        );
        return transcript
          ? toReadSessionResult(transcript)
          : {
              channel: parsed.channel,
              found: false,
            };
      },
      inputSchema: ReadSessionToolInputSchema,
    };
  }

  return tools;
}

function sessionFilter(options: WorkerAgentSessionToolOptions): {
  readonly excludeKey?: string;
  readonly sessionScopeKey?: string;
} {
  const current = options.currentConversationKey();
  const sessionScopeKey = options.currentSessionScopeKey?.();
  return {
    ...(current ? { excludeKey: current } : {}),
    ...(sessionScopeKey ? { sessionScopeKey } : {}),
  };
}

function toToolEntry(summary: SessionSummary): SessionToolEntry {
  return {
    channel: channelKey(summary.channel),
    lastSeenAt: new Date(summary.lastSeenAt).toISOString(),
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

function toReadSessionResult(
  transcript: SessionTranscript
): ReadSessionToolResult {
  return {
    channel: transcript.conversationKey,
    found: true,
    hasMore: transcript.hasMore,
    messageCount: transcript.messageCount,
    messages: transcript.messages,
    ...(transcript.nextCursor === undefined
      ? {}
      : { nextCursor: transcript.nextCursor }),
  };
}
