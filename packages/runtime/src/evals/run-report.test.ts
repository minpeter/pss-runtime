import { jsonSchema, type ToolSet, tool } from "ai";
import { describe, expect, it } from "vitest";

import { Agent } from "../agent/core/agent";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
  mockLanguageModelV4ToolCall,
} from "../testing/mock-language-model-v4-test-utils";
import { clearEvals, defineEval, runEvals } from "./index";

const tools = {
  get_weather: tool({
    execute: (input) => ({
      city: readCity(input),
      condition: "맑음",
      tempC: 21,
    }),
    inputSchema: jsonSchema({
      additionalProperties: false,
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    }),
  }),
} satisfies ToolSet;

describe("eval run reports", () => {
  it("records each t.run in the case result for JSON inspection", async () => {
    clearEvals();
    defineEval("multi-run-report", { thread: twoTurnWeatherThread }, (it) => {
      it("keeps two run traces", async (t) => {
        await t.run("서울 날씨?");
        await t.run("부산 날씨?");
        t.calledTool("get_weather", { times: 2 });
        t.messageIncludes("부산");
      });
    });

    const report = await runEvals();
    const result = report.results[0];

    expect(report.failed).toBe(0);
    expect(result).toHaveProperty(["runs", "length"], 2);
    expect(result).toMatchObject({
      runs: [
        {
          events: expect.arrayContaining([
            expect.objectContaining({ type: "assistant-output" }),
            expect.objectContaining({ type: "tool-call" }),
          ]),
          input: "서울 날씨?",
          output: expect.stringContaining("서울"),
          toolCalls: [
            expect.objectContaining({
              toolCallId: "call_weather_first",
              toolName: "get_weather",
            }),
          ],
        },
        {
          events: expect.arrayContaining([
            expect.objectContaining({ type: "assistant-output" }),
            expect.objectContaining({ type: "tool-call" }),
          ]),
          input: "부산 날씨?",
          output: expect.stringContaining("부산"),
          toolCalls: [
            expect.objectContaining({
              toolCallId: "call_weather_second",
              toolName: "get_weather",
            }),
          ],
        },
      ],
    });
  });
});

function twoTurnWeatherThread() {
  return new Agent({
    instructions: "You are a helpful assistant. Answer in Korean.",
    model: createMockLanguageModelV4([
      mockLanguageModelV4ToolCall({
        input: { city: "서울" },
        toolCallId: "call_weather_first",
        toolName: "get_weather",
      }),
      mockLanguageModelV4Text("서울은 맑음입니다."),
      mockLanguageModelV4ToolCall({
        input: { city: "부산" },
        toolCallId: "call_weather_second",
        toolName: "get_weather",
      }),
      mockLanguageModelV4Text("부산도 맑음입니다."),
    ]),
    tools,
  }).thread("eval");
}

function readCity(input: unknown): string {
  return typeof input === "object" &&
    input !== null &&
    "city" in input &&
    typeof input.city === "string"
    ? input.city
    : "서울";
}
