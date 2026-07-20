import type { WorkerAgentSessionToolOptions } from "../session/session-tools";
import type {
  SessionTranscript,
  SessionTranscriptReader,
} from "../session/session-transcript";
import type {
  SessionIndexReader,
  SessionListOptions,
  SessionReadAuthorizationOptions,
  SessionSearchOptions,
  SessionSearchResult,
} from "../session-index/session-index";
import {
  defaultSessionRecords,
  type EvalSessionRecord,
} from "./session-fixture-records";

const WHITESPACE_PATTERN = /\s+/;
export const DEFAULT_EVAL_SESSION_SCOPE_KEY = "requester:eval";

interface EvalSessionToolsOptions {
  readonly currentSessionScopeKey?: string;
  readonly missingTranscriptChannels?: readonly string[];
  readonly records?: readonly EvalSessionRecord[];
}

export function createEvalSessionTools(
  options: EvalSessionToolsOptions = {}
): WorkerAgentSessionToolOptions {
  const records = options.records ?? defaultSessionRecords;
  const currentScopeKey =
    options.currentSessionScopeKey ?? DEFAULT_EVAL_SESSION_SCOPE_KEY;
  const missingChannels = new Set(options.missingTranscriptChannels ?? []);
  const reader = {
    canRead: (conversationKey, readOptions) =>
      Promise.resolve(canReadRecord(records, conversationKey, readOptions)),
    list: (listOptions) =>
      Promise.resolve(
        limitRecords(filterRecords(records, listOptions), listOptions).map(
          (record) => record.summary
        )
      ),
    search: (query, searchOptions) =>
      Promise.resolve(
        limitRecords(
          searchRecords(filterRecords(records, searchOptions), query),
          searchOptions
        ).map(toSearchResult)
      ),
  } satisfies SessionIndexReader;
  const transcriptReader = {
    read: (conversationKey) =>
      Promise.resolve(
        readTranscript(records, missingChannels, conversationKey)
      ),
  } satisfies SessionTranscriptReader;
  return {
    currentConversationKey: () => "tui:eval",
    currentSessionScopeKey: () => currentScopeKey,
    reader,
    transcriptReader,
  };
}

function filterRecords(
  records: readonly EvalSessionRecord[],
  options?: SessionListOptions | SessionSearchOptions
): readonly EvalSessionRecord[] {
  return records.filter((record) => isVisibleRecord(record, options));
}

function isVisibleRecord(
  record: EvalSessionRecord,
  options?: SessionListOptions | SessionSearchOptions
): boolean {
  if (record.summary.conversationKey === options?.excludeKey) {
    return false;
  }
  const scopeKey = options?.sessionScopeKey?.trim();
  return !scopeKey || recordScopeKey(record) === scopeKey;
}

function canReadRecord(
  records: readonly EvalSessionRecord[],
  conversationKey: string,
  options?: SessionReadAuthorizationOptions
): boolean {
  const record = records.find(
    (candidate) => candidate.summary.conversationKey === conversationKey
  );
  return Boolean(record && isVisibleRecord(record, options));
}

function recordScopeKey(record: EvalSessionRecord): string {
  return record.sessionScopeKey ?? DEFAULT_EVAL_SESSION_SCOPE_KEY;
}

function searchRecords(
  records: readonly EvalSessionRecord[],
  query: string
): readonly EvalSessionRecord[] {
  const tokens = query.toLowerCase().split(WHITESPACE_PATTERN).filter(Boolean);
  return records.filter((record) =>
    tokens.some((token) => recordMatches(record, token))
  );
}

function recordMatches(record: EvalSessionRecord, token: string): boolean {
  const haystack = [
    record.summary.conversationKey,
    record.summary.snippet,
    ...record.keywords,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(token);
}

function limitRecords(
  records: readonly EvalSessionRecord[],
  options?: SessionListOptions | SessionSearchOptions
): readonly EvalSessionRecord[] {
  return records.slice(0, options?.limit ?? records.length);
}

function toSearchResult(record: EvalSessionRecord): SessionSearchResult {
  return { ...record.summary, score: record.score };
}

function readTranscript(
  records: readonly EvalSessionRecord[],
  missingChannels: ReadonlySet<string>,
  conversationKey: string
): SessionTranscript | undefined {
  if (missingChannels.has(conversationKey)) {
    return;
  }
  const record = records.find(
    (candidate) => candidate.summary.conversationKey === conversationKey
  );
  return record
    ? {
        conversationKey,
        hasMore: false,
        messageCount: record.messages.length,
        messages: record.messages,
      }
    : undefined;
}
