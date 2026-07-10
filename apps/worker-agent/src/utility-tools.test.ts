import { describe, expect, it } from "vitest";

import {
  CALCULATE_TOOL_NAME,
  type CalculateToolResult,
  createUtilityTools,
  evaluateArithmeticExpression,
  GET_CURRENT_TIME_TOOL_NAME,
  type GetCurrentTimeToolResult,
} from "./utility-tools";

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    context: undefined,
    messages: [] as [],
    toolCallId: "call-1",
  };
}

describe("evaluateArithmeticExpression", () => {
  it("evaluates nested arithmetic", () => {
    expect(evaluateArithmeticExpression("(12.5 + 3) * 2")).toBe(31);
    expect(evaluateArithmeticExpression("2^3 + 1")).toBe(9);
    expect(evaluateArithmeticExpression("-4 * (2 + 1)")).toBe(-12);
  });

  it("rejects unsafe input", () => {
    expect(() => evaluateArithmeticExpression("Math.sin(1)")).toThrow(
      /Invalid character/
    );
  });
});

describe("utility tools", () => {
  it("calculate returns a finite result", async () => {
    const tools = createUtilityTools();
    const result = (await tools[CALCULATE_TOOL_NAME]?.execute?.(
      { expression: "10 / 4" },
      toolContext()
    )) as CalculateToolResult;
    expect(result).toEqual({ expression: "10 / 4", result: 2.5 });
  });

  it("get_current_time returns iso for a zone", async () => {
    const tools = createUtilityTools();
    const result = (await tools[GET_CURRENT_TIME_TOOL_NAME]?.execute?.(
      { timeZone: "UTC" },
      toolContext()
    )) as GetCurrentTimeToolResult;
    expect(result.timeZone).toBe("UTC");
    expect(result.unixMs).toEqual(expect.any(Number));
    expect(result.iso).toContain("UTC");
  });
});
