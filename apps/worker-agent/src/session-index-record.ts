import type { SessionIndexRecord, SessionTurnUpdate } from "./session-index";

export const MAX_RECENT_USER_TEXT = 5;
export const MAX_RECENT_ASSISTANT_TEXT = 3;
export const SESSION_SNIPPET_MAX_LENGTH = 160;

export interface SessionRecordFilterOptions {
  readonly excludeKey?: string;
  readonly sessionScopeKey?: string;
}

export function appendRecent(
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

export function buildSessionSnippet(record: SessionIndexRecord): string {
  const source =
    record.recentUserText.at(-1) ?? record.recentAssistantText.at(-1) ?? "";
  const collapsed = source.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= SESSION_SNIPPET_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, SESSION_SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

export function filterSessionRecords(
  records: readonly SessionIndexRecord[],
  options: SessionRecordFilterOptions = {}
): readonly SessionIndexRecord[] {
  return records.filter((record) => isSessionRecordVisible(record, options));
}

export function isSessionRecordVisible(
  record: SessionIndexRecord,
  options: SessionRecordFilterOptions = {}
): boolean {
  if (record.conversationKey === options.excludeKey) {
    return false;
  }
  const scopeKey = options.sessionScopeKey?.trim();
  return !scopeKey || sessionScopeKey(record) === scopeKey;
}

export function sessionScopeKey(record: SessionIndexRecord): string {
  return record.sessionScopeKey ?? record.conversationKey;
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
  const nextSessionScopeKey =
    update.sessionScopeKey?.trim() ||
    existing?.sessionScopeKey ||
    conversationKey;

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
    sessionScopeKey: nextSessionScopeKey,
    threadKey: update.threadKey,
    turnCount: (existing?.turnCount ?? 0) + 1,
  };
}

export function byRecency(
  left: SessionIndexRecord,
  right: SessionIndexRecord
): number {
  return (
    right.lastSeenAt - left.lastSeenAt ||
    left.conversationKey.localeCompare(right.conversationKey)
  );
}

export function byScoreThenRecency(
  left: { readonly record: SessionIndexRecord; readonly score: number },
  right: { readonly record: SessionIndexRecord; readonly score: number }
): number {
  return right.score - left.score || byRecency(left.record, right.record);
}
