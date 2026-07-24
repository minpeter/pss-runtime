import { describe, expect, it } from "vitest";
import { selectSummaryOutputTokenLimit } from "./auto-compaction-runner";

describe("selectSummaryOutputTokenLimit", () => {
  it("caps dense short ranges to half their input tokens", () => {
    expect(
      selectSummaryOutputTokenLimit({
        inputTokens: 700,
        retainTokens: 3200,
      })
    ).toBe(350);
  });

  it("keeps the policy-derived ceiling for large ranges", () => {
    expect(
      selectSummaryOutputTokenLimit({
        inputTokens: 50_000,
        retainTokens: 3200,
      })
    ).toBe(1600);
  });

  it("keeps a minimum viable summary budget", () => {
    expect(
      selectSummaryOutputTokenLimit({
        inputTokens: 300,
        retainTokens: 3200,
      })
    ).toBe(256);
  });
});
