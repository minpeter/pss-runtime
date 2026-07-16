import { describe, expect, it } from "vitest";
import type { ModelUsage } from "../thread/protocol/events";
import { summarizeCacheUsage } from "./cache";

describe("summarizeCacheUsage", () => {
  it("keeps unreported provider counts distinct from explicit zeroes", () => {
    const unreported = summarizeCacheUsage([{ type: "model-usage" }]);
    const zeroes = summarizeCacheUsage([
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 0,
        noCacheTokens: 0,
        type: "model-usage",
      },
    ]);

    expect(unreported).toMatchObject({ requests: 1, trackedRequests: 0 });
    expect(unreported.cacheReadTokens).toBeUndefined();
    expect(unreported.inputTokens).toBeUndefined();
    expect(JSON.parse(JSON.stringify(unreported))).toEqual({
      requests: 1,
      trackedRequests: 0,
    });

    expect(zeroes).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      noCacheTokens: 0,
      requests: 1,
      trackedCacheReadTokens: 0,
      trackedInputTokens: 0,
      trackedRequests: 1,
    });
    expect(zeroes.cacheHitRate).toBeUndefined();
  });

  it("uses only paired cache-read and input counts for the hit rate", () => {
    const usages: ModelUsage[] = [
      { cacheReadTokens: 80, inputTokens: 100, type: "model-usage" },
      { inputTokens: 50, type: "model-usage" },
      { cacheReadTokens: 20, type: "model-usage" },
      { cacheReadTokens: 0, inputTokens: 0, type: "model-usage" },
    ];

    expect(summarizeCacheUsage(usages)).toEqual({
      cacheHitRate: 0.8,
      cacheReadTokens: 100,
      cacheWriteTokens: undefined,
      inputTokens: 150,
      noCacheTokens: undefined,
      requests: 4,
      trackedCacheReadTokens: 80,
      trackedInputTokens: 100,
      trackedRequests: 2,
    });
  });
});
