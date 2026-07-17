import { describe, expect, it } from "vitest";
import type { ModelUsage } from "../thread/protocol/events";
import { summarizeCacheUsage } from "./cache";

describe("summarizeCacheUsage", () => {
  it("keeps unreported provider counts distinct from explicit zeroes", () => {
    const unreported = summarizeCacheUsage([
      { attemptId: "attempt-unreported", type: "model-usage" },
    ]);
    const zeroes = summarizeCacheUsage([
      {
        attemptId: "attempt-zero",
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 0,
        noCacheTokens: 0,
        type: "model-usage",
      },
    ]);

    expect(unreported).toMatchObject({
      attemptedRequests: 1,
      duplicateUsageRecords: 0,
      failedRequests: 0,
      invalidPairedRequests: 0,
      successfulRequests: 1,
      telemetryCoverage: 0,
      trackedRequests: 0,
    });
    expect(unreported.cacheReadTokens).toBeUndefined();
    expect(unreported.inputTokens).toBeUndefined();
    expect(JSON.parse(JSON.stringify(unreported))).toEqual({
      attemptedRequests: 1,
      duplicateUsageRecords: 0,
      failedRequests: 0,
      invalidPairedRequests: 0,
      successfulRequests: 1,
      telemetryCoverage: 0,
      trackedRequests: 0,
    });

    expect(zeroes).toMatchObject({
      attemptedRequests: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      duplicateUsageRecords: 0,
      failedRequests: 0,
      inputTokens: 0,
      invalidPairedRequests: 0,
      noCacheTokens: 0,
      successfulRequests: 1,
      telemetryCoverage: 1,
      trackedCacheReadTokens: 0,
      trackedInputTokens: 0,
      trackedRequests: 1,
    });
    expect(zeroes.cacheHitRate).toBeUndefined();
  });

  it("uses only paired cache-read and input counts for the hit rate", () => {
    const usages: ModelUsage[] = [
      {
        attemptId: "attempt-paired",
        cacheReadTokens: 80,
        inputTokens: 100,
        type: "model-usage",
      },
      {
        attemptId: "attempt-input-only",
        inputTokens: 50,
        type: "model-usage",
      },
      {
        attemptId: "attempt-cache-only",
        cacheReadTokens: 20,
        type: "model-usage",
      },
      {
        attemptId: "attempt-zero-input",
        cacheReadTokens: 0,
        inputTokens: 0,
        type: "model-usage",
      },
    ];

    expect(summarizeCacheUsage(usages)).toEqual({
      attemptedRequests: 4,
      cacheHitRate: 0.8,
      cacheReadTokens: 100,
      cacheWriteTokens: undefined,
      duplicateUsageRecords: 0,
      failedRequests: 0,
      inputTokens: 150,
      invalidPairedRequests: 0,
      noCacheTokens: undefined,
      successfulRequests: 4,
      telemetryCoverage: 0.5,
      trackedCacheReadTokens: 80,
      trackedInputTokens: 100,
      trackedRequests: 2,
    });
  });

  it("excludes malformed and impossible pairs without clamping them", () => {
    const usages = [
      {
        attemptId: "attempt-read-exceeds-input",
        cacheReadTokens: 101,
        inputTokens: 100,
        type: "model-usage",
      },
      {
        attemptId: "attempt-invalid-number",
        cacheReadTokens: Number.NaN,
        inputTokens: 100,
        type: "model-usage",
      },
      {
        attemptId: "attempt-valid",
        cacheReadTokens: 25,
        inputTokens: 50,
        type: "model-usage",
      },
    ] as ModelUsage[];

    expect(summarizeCacheUsage(usages)).toEqual({
      attemptedRequests: 3,
      cacheHitRate: 0.5,
      cacheReadTokens: 126,
      cacheWriteTokens: undefined,
      duplicateUsageRecords: 0,
      failedRequests: 0,
      inputTokens: 250,
      invalidPairedRequests: 2,
      noCacheTokens: undefined,
      successfulRequests: 3,
      telemetryCoverage: 1 / 3,
      trackedCacheReadTokens: 25,
      trackedInputTokens: 50,
      trackedRequests: 1,
    });
  });

  it("fails closed when paired or raw token totals exceed safe integers", () => {
    const usages = [
      {
        attemptId: "attempt-near-limit",
        cacheReadTokens: Number.MAX_SAFE_INTEGER,
        inputTokens: Number.MAX_SAFE_INTEGER,
        type: "model-usage",
      },
      {
        attemptId: "attempt-overflow",
        cacheReadTokens: 0,
        inputTokens: 1,
        type: "model-usage",
      },
    ] as ModelUsage[];

    expect(summarizeCacheUsage(usages)).toEqual({
      attemptedRequests: 2,
      cacheHitRate: undefined,
      cacheReadTokens: Number.MAX_SAFE_INTEGER,
      cacheWriteTokens: undefined,
      duplicateUsageRecords: 0,
      failedRequests: 0,
      inputTokens: undefined,
      invalidPairedRequests: 0,
      noCacheTokens: undefined,
      successfulRequests: 2,
      telemetryCoverage: 1,
      trackedCacheReadTokens: undefined,
      trackedInputTokens: undefined,
      trackedRequests: 2,
    });
  });

  it("uses all attempted model requests as the telemetry denominator", () => {
    const usages: ModelUsage[] = [
      {
        attemptId: "attempt-success",
        cacheReadTokens: 80,
        inputTokens: 100,
        type: "model-usage",
      },
    ];

    expect(summarizeCacheUsage(usages, { attemptedRequests: 4 })).toMatchObject(
      {
        attemptedRequests: 4,
        cacheHitRate: 0.8,
        duplicateUsageRecords: 0,
        failedRequests: 3,
        successfulRequests: 1,
        telemetryCoverage: 0.25,
        trackedRequests: 1,
      }
    );
  });

  it("counts a replayed attemptId once and reports the duplicate", () => {
    const first: ModelUsage = {
      attemptId: "attempt-replayed",
      cacheReadTokens: 80,
      inputTokens: 100,
      type: "model-usage",
    };
    const conflictingReplay: ModelUsage = {
      ...first,
      cacheReadTokens: 10,
    };

    expect(summarizeCacheUsage([first, conflictingReplay])).toMatchObject({
      attemptedRequests: 1,
      cacheHitRate: 0.8,
      cacheReadTokens: 80,
      duplicateUsageRecords: 1,
      failedRequests: 0,
      successfulRequests: 1,
      telemetryCoverage: 1,
      trackedCacheReadTokens: 80,
      trackedInputTokens: 100,
      trackedRequests: 1,
    });
  });

  it("rejects malformed and impossible cache-write envelopes", () => {
    const usages: ModelUsage[] = [
      {
        attemptId: "attempt-malformed-write",
        cacheReadTokens: 10,
        cacheWriteTokens: Number.NaN,
        inputTokens: 100,
        type: "model-usage",
      },
      {
        attemptId: "attempt-write-exceeds-input",
        cacheReadTokens: 0,
        cacheWriteTokens: 101,
        inputTokens: 100,
        type: "model-usage",
      },
      {
        attemptId: "attempt-sum-exceeds-input",
        cacheReadTokens: 80,
        cacheWriteTokens: 80,
        inputTokens: 100,
        type: "model-usage",
      },
      {
        attemptId: "attempt-sum-overflows",
        cacheReadTokens: Number.MAX_SAFE_INTEGER,
        cacheWriteTokens: Number.MAX_SAFE_INTEGER,
        inputTokens: Number.MAX_SAFE_INTEGER,
        type: "model-usage",
      },
      {
        attemptId: "attempt-exact-envelope",
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
        inputTokens: 100,
        type: "model-usage",
      },
    ];

    expect(summarizeCacheUsage(usages)).toMatchObject({
      cacheHitRate: 0.8,
      invalidPairedRequests: 4,
      telemetryCoverage: 0.2,
      trackedCacheReadTokens: 80,
      trackedInputTokens: 100,
      trackedRequests: 1,
    });
  });
});
