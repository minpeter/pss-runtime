import type { SessionIndexRecord } from "./session-index";

const WHITESPACE_PATTERN = /\s+/u;

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

export function tokenizeSearchText(normalized: string): readonly string[] {
  return normalized.split(WHITESPACE_PATTERN).filter(Boolean);
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
