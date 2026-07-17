import type { ModelUsage } from "../thread/protocol/events";
import type { EvalCacheStats } from "./types";

/** Aggregate provider-reported prompt-cache usage without inventing missing data. */
export function summarizeCacheUsage(
  usages: readonly ModelUsage[]
): EvalCacheStats {
  const cacheReadTokens = tokenAccumulator();
  const cacheWriteTokens = tokenAccumulator();
  const inputTokens = tokenAccumulator();
  const noCacheTokens = tokenAccumulator();
  let trackedCacheReadTokens: number | undefined;
  let trackedInputTokens: number | undefined;
  let trackedTokenTotalsOverflowed = false;
  let invalidPairedRequests = 0;
  let trackedRequests = 0;

  for (const usage of usages) {
    const cacheRead = safeTokenCount(usage.cacheReadTokens);
    const cacheWrite = safeTokenCount(usage.cacheWriteTokens);
    const input = safeTokenCount(usage.inputTokens);
    const noCache = safeTokenCount(usage.noCacheTokens);
    addReported(cacheReadTokens, cacheRead);
    addReported(cacheWriteTokens, cacheWrite);
    addReported(inputTokens, input);
    addReported(noCacheTokens, noCache);

    const pair = cacheInputPair(usage, cacheRead, input);
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
    cacheHitRate:
      trackedTokenTotalsOverflowed ||
      trackedInputTokens === undefined ||
      trackedInputTokens === 0
        ? undefined
        : (trackedCacheReadTokens ?? 0) / trackedInputTokens,
    cacheReadTokens: cacheReadTokens.value,
    cacheWriteTokens: cacheWriteTokens.value,
    inputTokens: inputTokens.value,
    invalidPairedRequests,
    noCacheTokens: noCacheTokens.value,
    requests: usages.length,
    telemetryCoverage:
      usages.length === 0 ? undefined : trackedRequests / usages.length,
    trackedCacheReadTokens,
    trackedInputTokens,
    trackedRequests,
  };
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
  input: number | undefined
): CacheInputPair {
  if (usage.cacheReadTokens === undefined || usage.inputTokens === undefined) {
    return { kind: "absent" };
  }
  if (cacheRead === undefined || input === undefined || cacheRead > input) {
    return { kind: "invalid" };
  }
  return { cacheRead, input, kind: "valid" };
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
