import type { ModelUsage } from "../thread/protocol/events";
import type { EvalCacheStats } from "./types";

/** Aggregate provider-reported prompt-cache usage without inventing missing data. */
export function summarizeCacheUsage(
  usages: readonly ModelUsage[]
): EvalCacheStats {
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let inputTokens: number | undefined;
  let noCacheTokens: number | undefined;
  let trackedCacheReadTokens: number | undefined;
  let trackedInputTokens: number | undefined;
  let trackedRequests = 0;

  for (const usage of usages) {
    cacheReadTokens = addReported(cacheReadTokens, usage.cacheReadTokens);
    cacheWriteTokens = addReported(cacheWriteTokens, usage.cacheWriteTokens);
    inputTokens = addReported(inputTokens, usage.inputTokens);
    noCacheTokens = addReported(noCacheTokens, usage.noCacheTokens);

    if (
      usage.cacheReadTokens !== undefined &&
      usage.inputTokens !== undefined
    ) {
      trackedCacheReadTokens = addReported(
        trackedCacheReadTokens,
        usage.cacheReadTokens
      );
      trackedInputTokens = addReported(trackedInputTokens, usage.inputTokens);
      trackedRequests += 1;
    }
  }

  return {
    cacheHitRate:
      trackedInputTokens === undefined || trackedInputTokens === 0
        ? undefined
        : (trackedCacheReadTokens ?? 0) / trackedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    noCacheTokens,
    requests: usages.length,
    trackedCacheReadTokens,
    trackedInputTokens,
    trackedRequests,
  };
}

function addReported(
  total: number | undefined,
  value: number | undefined
): number | undefined {
  return value === undefined ? total : (total ?? 0) + value;
}
