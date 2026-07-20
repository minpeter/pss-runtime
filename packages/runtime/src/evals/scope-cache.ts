import { summarizeCacheUsage } from "./cache";
import type { CacheHitRateOptions, EvalCacheStats, EvalRun } from "./types";

interface CacheHitRateResult {
  readonly detail: string;
  readonly pass: boolean;
  readonly rate: number | undefined;
}

export function evaluateCacheHitRate(
  runs: readonly EvalRun[],
  minimum: number,
  options: CacheHitRateOptions
): CacheHitRateResult {
  assertRate(minimum);
  const warmupRuns = options.warmupRuns ?? 0;
  const minTrackedRequests = options.minTrackedRequests ?? 1;
  const minTelemetryCoverage = options.minTelemetryCoverage ?? 0;
  assertNonNegativeInteger("warmupRuns", warmupRuns);
  assertNonNegativeInteger("minTrackedRequests", minTrackedRequests);
  assertRate(minTelemetryCoverage, "minTelemetryCoverage");

  const selectedRuns = runs.slice(warmupRuns);
  const cache = summarizeRunsCache(selectedRuns);
  const failedRuns = selectedRuns.filter(
    (run) => run.error !== undefined
  ).length;
  const rate = cache.cacheHitRate;
  const enoughRequests = cache.trackedRequests >= minTrackedRequests;
  const enoughCoverage =
    cache.telemetryCoverage !== undefined &&
    cache.telemetryCoverage >= minTelemetryCoverage;
  const pass =
    failedRuns === 0 &&
    cache.failedRequests === 0 &&
    cache.duplicateUsageRecords === 0 &&
    rate !== undefined &&
    enoughRequests &&
    enoughCoverage &&
    rate >= minimum;
  const detail = cacheHitRateFailure({
    cache,
    enoughCoverage,
    enoughRequests,
    failedRuns,
    minTelemetryCoverage,
    minTrackedRequests,
    minimum,
    rate,
  });
  return { detail, pass, rate };
}

export function summarizeRunsCache(runs: readonly EvalRun[]): EvalCacheStats {
  return summarizeCacheUsage(
    runs.flatMap((run) => run.modelUsage),
    {
      attemptedRequests: runs.reduce(
        (total, run) => total + run.cache.attemptedRequests,
        0
      ),
    }
  );
}

function assertRate(value: number, name = "cache hit rate"): void {
  if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!(Number.isInteger(value) && value >= 0)) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function cacheHitRateFailure({
  cache,
  enoughCoverage,
  enoughRequests,
  failedRuns,
  minTelemetryCoverage,
  minTrackedRequests,
  minimum,
  rate,
}: {
  readonly cache: EvalCacheStats;
  readonly enoughCoverage: boolean;
  readonly enoughRequests: boolean;
  readonly failedRuns: number;
  readonly minTelemetryCoverage: number;
  readonly minTrackedRequests: number;
  readonly minimum: number;
  readonly rate: number | undefined;
}): string {
  if (failedRuns > 0) {
    return `${failedRuns} post-warmup run(s) ended with turn-error; cache hit rate is indeterminate`;
  }
  if (cache.duplicateUsageRecords > 0) {
    return `${cache.duplicateUsageRecords} duplicate post-warmup model-usage record(s) reused an attemptId; cache hit rate is indeterminate`;
  }
  if (cache.failedRequests > 0) {
    return `${cache.failedRequests}/${cache.attemptedRequests} post-warmup model attempt(s) ended without model-usage; cache hit rate is indeterminate`;
  }
  if (!enoughRequests) {
    return `provider cache usage tracked for ${cache.trackedRequests} request(s); expected at least ${minTrackedRequests}`;
  }
  if (!enoughCoverage) {
    const observed = cache.telemetryCoverage;
    return observed === undefined
      ? `provider cache telemetry coverage was unavailable; expected at least ${minTelemetryCoverage.toFixed(4)}`
      : `provider cache telemetry coverage ${observed.toFixed(4)} was below ${minTelemetryCoverage.toFixed(4)} (${cache.trackedRequests}/${cache.attemptedRequests} requests)`;
  }
  if (rate === undefined) {
    if (
      cache.trackedRequests > 0 &&
      cache.trackedInputTokens === undefined &&
      cache.trackedCacheReadTokens === undefined
    ) {
      return "provider-reported paired token totals exceeded the safe integer range";
    }
    return cache.trackedInputTokens === 0
      ? "provider-reported tracked input token total was zero"
      : "provider did not report cache-read and input token counts";
  }
  return `cache hit rate ${rate.toFixed(4)} was below ${minimum.toFixed(4)} (${cache.trackedCacheReadTokens}/${cache.trackedInputTokens} tokens)`;
}
