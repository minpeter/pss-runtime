import type { ModelUsage } from "../thread/protocol/events";
import type { CacheUsageSummaryOptions, EvalCacheStats } from "./types";

/** Aggregate provider-reported prompt-cache usage without inventing missing data. */
export function summarizeCacheUsage(
  usages: readonly ModelUsage[],
  options: CacheUsageSummaryOptions = {}
): EvalCacheStats {
  const { duplicateUsageRecords, uniqueUsages } = uniqueUsageRecords(usages);
  const attemptedRequests = resolveAttemptedRequests(
    uniqueUsages.length,
    options.attemptedRequests
  );
  const cacheReadTokens = tokenAccumulator();
  const cacheWriteTokens = tokenAccumulator();
  const inputTokens = tokenAccumulator();
  const noCacheTokens = tokenAccumulator();
  let trackedCacheReadTokens: number | undefined;
  let trackedInputTokens: number | undefined;
  let trackedTokenTotalsOverflowed = false;
  let invalidPairedRequests = 0;
  let trackedRequests = 0;

  for (const usage of uniqueUsages) {
    const cacheRead = safeTokenCount(usage.cacheReadTokens);
    const cacheWrite = safeTokenCount(usage.cacheWriteTokens);
    const input = safeTokenCount(usage.inputTokens);
    const noCache = safeTokenCount(usage.noCacheTokens);
    addReported(cacheReadTokens, cacheRead);
    addReported(cacheWriteTokens, cacheWrite);
    addReported(inputTokens, input);
    addReported(noCacheTokens, noCache);

    const pair = cacheInputPair(usage, cacheRead, cacheWrite, input);
    if (pair.kind === "absent") {
      continue;
    }
    if (pair.kind === "invalid") {
      invalidPairedRequests += 1;
      continue;
    }
    trackedRequests += 1;
    if (trackedTokenTotalsOverflowed) {
      continue;
    }
    const nextCacheReadTokens = (trackedCacheReadTokens ?? 0) + pair.cacheRead;
    const nextInputTokens = (trackedInputTokens ?? 0) + pair.input;
    if (
      !(
        Number.isSafeInteger(nextCacheReadTokens) &&
        Number.isSafeInteger(nextInputTokens)
      )
    ) {
      trackedCacheReadTokens = undefined;
      trackedInputTokens = undefined;
      trackedTokenTotalsOverflowed = true;
      continue;
    }
    trackedCacheReadTokens = nextCacheReadTokens;
    trackedInputTokens = nextInputTokens;
  }

  return {
    attemptedRequests,
    cacheHitRate:
      trackedTokenTotalsOverflowed ||
      trackedInputTokens === undefined ||
      trackedInputTokens === 0
        ? undefined
        : (trackedCacheReadTokens ?? 0) / trackedInputTokens,
    cacheReadTokens: cacheReadTokens.value,
    cacheWriteTokens: cacheWriteTokens.value,
    duplicateUsageRecords,
    failedRequests: attemptedRequests - uniqueUsages.length,
    inputTokens: inputTokens.value,
    invalidPairedRequests,
    noCacheTokens: noCacheTokens.value,
    telemetryCoverage:
      attemptedRequests === 0 ? undefined : trackedRequests / attemptedRequests,
    successfulRequests: uniqueUsages.length,
    trackedCacheReadTokens,
    trackedInputTokens,
    trackedRequests,
  };
}

function uniqueUsageRecords(usages: readonly ModelUsage[]): {
  readonly duplicateUsageRecords: number;
  readonly uniqueUsages: readonly ModelUsage[];
} {
  const seenAttemptIds = new Set<string>();
  const uniqueUsages: ModelUsage[] = [];
  let duplicateUsageRecords = 0;
  for (const usage of usages) {
    if (seenAttemptIds.has(usage.attemptId)) {
      duplicateUsageRecords += 1;
      continue;
    }
    seenAttemptIds.add(usage.attemptId);
    uniqueUsages.push(usage);
  }
  return { duplicateUsageRecords, uniqueUsages };
}

interface TokenAccumulator {
  overflowed: boolean;
  value: number | undefined;
}

type CacheInputPair =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { cacheRead: number; input: number; kind: "valid" };

function cacheInputPair(
  usage: ModelUsage,
  cacheRead: number | undefined,
  cacheWrite: number | undefined,
  input: number | undefined
): CacheInputPair {
  if (usage.cacheReadTokens === undefined || usage.inputTokens === undefined) {
    return { kind: "absent" };
  }
  if (cacheRead === undefined || input === undefined || cacheRead > input) {
    return { kind: "invalid" };
  }
  if (usage.cacheWriteTokens !== undefined) {
    if (cacheWrite === undefined || cacheWrite > input) {
      return { kind: "invalid" };
    }
    const cachedTokens = cacheRead + cacheWrite;
    if (!Number.isSafeInteger(cachedTokens) || cachedTokens > input) {
      return { kind: "invalid" };
    }
  }
  return { cacheRead, input, kind: "valid" };
}

function resolveAttemptedRequests(
  successfulRequests: number,
  attemptedRequests = successfulRequests
): number {
  if (
    !Number.isSafeInteger(attemptedRequests) ||
    attemptedRequests < successfulRequests
  ) {
    throw new RangeError(
      "attemptedRequests must be a safe integer greater than or equal to the number of usage records"
    );
  }
  return attemptedRequests;
}

function tokenAccumulator(): TokenAccumulator {
  return { overflowed: false, value: undefined };
}

function safeTokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function addReported(total: TokenAccumulator, value: number | undefined): void {
  if (value === undefined || total.overflowed) {
    return;
  }
  const next = (total.value ?? 0) + value;
  if (!Number.isSafeInteger(next)) {
    total.overflowed = true;
    total.value = undefined;
    return;
  }
  total.value = next;
}
