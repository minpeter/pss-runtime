import { jsonSchema, type ToolSet, tool } from "ai";
import { describe, expect, it } from "vitest";

import { Agent } from "../agent/core/agent";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4Usage,
  mockLanguageModelV4Text,
  mockLanguageModelV4ToolCall,
} from "../testing/mock-language-model-v4-test-utils";
import {
  clearEvals,
  defineEval,
  type EvalThreadLike,
  formatJsonReport,
  formatTextReport,
  runEvals,
} from "./index";

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

  it("keeps per-attempt cache traces and gates on steady-state hit rate", async () => {
    clearEvals();
    defineEval("cache-trace", { thread: cacheTraceThread }, (it) => {
      it("tracks a warmed long-running thread", async (t) => {
        await t.run("turn 1");
        await t.run("turn 2");
        await t.run("turn 3");
        t.cacheHitRateAtLeast(0.8, {
          minTelemetryCoverage: 1,
          minTrackedRequests: 2,
          warmupRuns: 1,
        });
      });
    });

    const report = await runEvals();
    const result = report.results[0];

    expect(result.passed).toBe(true);
    expect(result.runs.map((run) => run.modelUsage)).toEqual([
      [
        expect.objectContaining({
          cacheReadTokens: 0,
          finishReason: "stop",
          inputTokens: 100,
          reasoningTokens: 4,
        }),
      ],
      [expect.objectContaining({ cacheReadTokens: 160, inputTokens: 200 })],
      [expect.objectContaining({ cacheReadTokens: 210, inputTokens: 240 })],
    ]);
    expect(result.cache).toMatchObject({
      attemptedRequests: 3,
      cacheHitRate: 370 / 540,
      cacheReadTokens: 370,
      failedRequests: 0,
      inputTokens: 540,
      successfulRequests: 3,
      trackedRequests: 3,
    });
    expect(result.assertions).toContainEqual(
      expect.objectContaining({
        label: "cacheHitRateAtLeast(0.8)",
        passed: true,
        score: 370 / 440,
      })
    );
    expect(report.cache).toEqual(result.cache);
    expect(formatTextReport(report)).toContain("cache hit 68.5%");
    const jsonReport = JSON.parse(formatJsonReport(report));
    expect(jsonReport.cache).toMatchObject({
      cacheHitRate: 370 / 540,
      trackedCacheReadTokens: 370,
      trackedInputTokens: 540,
    });
    expect(jsonReport.results[0].runs[0].modelUsage[0]).toMatchObject({
      durationMs: expect.any(Number),
      finishReason: "stop",
      modelId: expect.any(String),
      provider: expect.any(String),
      reasoningTokens: 4,
    });
    expect(JSON.stringify(jsonReport)).not.toContain("provider-raw-secret");
  });

  it("does not treat unsupported provider cache telemetry as a zero-rate sample", async () => {
    clearEvals();
    defineEval(
      "cache-unreported",
      {
        thread: () =>
          new Agent({
            model: createMockLanguageModelV4([
              mockLanguageModelV4Text("no usage"),
            ]),
          }).thread("cache-unreported"),
      },
      (it) => {
        it("requires reported token counts", async (t) => {
          await t.run("hello");
          t.cacheHitRateAtLeast(0);
        });
      }
    );

    const report = await runEvals();
    const result = report.results[0];

    expect(result.passed).toBe(false);
    expect(result.cache.cacheHitRate).toBeUndefined();
    expect(result.cache.cacheReadTokens).toBeUndefined();
    expect(result.cache.inputTokens).toBeUndefined();
    expect(result.assertions[0]).toMatchObject({
      failure: expect.stringContaining("tracked for 0 request"),
      passed: false,
    });
    expect(JSON.parse(formatJsonReport(report)).cache).toEqual({
      attemptedRequests: 1,
      duplicateUsageRecords: 0,
      failedRequests: 0,
      invalidPairedRequests: 0,
      successfulRequests: 1,
      telemetryCoverage: 0,
      trackedRequests: 0,
    });
  });

  it("jointly gates cache rate on tracked request count and telemetry coverage", async () => {
    clearEvals();
    defineEval(
      "cache-sparse-telemetry",
      {
        thread: () =>
          new Agent({
            model: createMockLanguageModelV4([
              mockLanguageModelV4Text("tracked one", cacheUsage(100, 90)),
              mockLanguageModelV4Text("unreported one"),
              mockLanguageModelV4Text("tracked two", cacheUsage(100, 90)),
              mockLanguageModelV4Text("unreported two"),
            ]),
          }).thread("cache-sparse-telemetry"),
      },
      (it) => {
        it("does not trust a high rate from sparse telemetry", async (t) => {
          await t.run("one");
          await t.run("two");
          await t.run("three");
          await t.run("four");
          t.cacheHitRateAtLeast(0.8, {
            minTelemetryCoverage: 0.75,
            minTrackedRequests: 2,
          });
        });
      }
    );

    const result = (await runEvals()).results[0];
    expect(result.cache).toMatchObject({
      attemptedRequests: 4,
      cacheHitRate: 0.9,
      failedRequests: 0,
      successfulRequests: 4,
      telemetryCoverage: 0.5,
      trackedRequests: 2,
    });
    expect(result.assertions[0]).toMatchObject({
      failure: expect.stringContaining(
        "cache telemetry coverage 0.5000 was below 0.7500"
      ),
      passed: false,
      score: 0.9,
    });
    expect(result.passed).toBe(false);
  });

  it("rejects a cache-rate gate when tracked input is explicitly zero", async () => {
    clearEvals();
    defineEval(
      "cache-zero-input",
      {
        thread: () =>
          new Agent({
            model: createMockLanguageModelV4([
              mockLanguageModelV4Text("zero", cacheUsage(0, 0)),
            ]),
          }).thread("cache-zero-input"),
      },
      (it) => {
        it("does not invent a zero-percent rate", async (t) => {
          await t.run("hello");
          t.cacheHitRateAtLeast(0);
        });
      }
    );

    const report = await runEvals();
    expect(report.results[0]).toMatchObject({
      assertions: [
        expect.objectContaining({
          failure: expect.stringContaining("input token total was zero"),
          passed: false,
        }),
      ],
      cache: {
        attemptedRequests: 1,
        cacheReadTokens: 0,
        failedRequests: 0,
        inputTokens: 0,
        invalidPairedRequests: 0,
        successfulRequests: 1,
        telemetryCoverage: 1,
        trackedCacheReadTokens: 0,
        trackedInputTokens: 0,
        trackedRequests: 1,
      },
      passed: false,
    });
  });

  it("does not let an impossible cache-write envelope pass the cache gate", async () => {
    clearEvals();
    defineEval(
      "cache-invalid-envelope",
      {
        thread: () =>
          new Agent({
            model: createMockLanguageModelV4([
              mockLanguageModelV4Text("invalid", cacheUsage(100, 80, 80)),
            ]),
          }).thread("cache-invalid-envelope"),
      },
      (it) => {
        it("fails closed", async (t) => {
          await t.run("hello");
          t.cacheHitRateAtLeast(0.8);
        });
      }
    );

    const result = (await runEvals()).results[0];
    expect(result).toMatchObject({
      assertions: [
        expect.objectContaining({
          failure: expect.stringContaining("tracked for 0 request"),
          passed: false,
        }),
      ],
      cache: {
        attemptedRequests: 1,
        cacheReadTokens: 80,
        cacheWriteTokens: 80,
        failedRequests: 0,
        inputTokens: 100,
        invalidPairedRequests: 1,
        successfulRequests: 1,
        telemetryCoverage: 0,
        trackedRequests: 0,
      },
      passed: false,
    });
  });

  it("fails a cache gate when earlier model attempts ended without usage", async () => {
    clearEvals();
    defineEval(
      "cache-failed-attempts",
      { thread: failedAttemptsThenSuccessThread },
      (it) => {
        it("keeps failed attempts in the denominator", async (t) => {
          await t.run("failure one");
          await t.run("failure two");
          await t.run("failure three");
          await t.run("success");
          t.cacheHitRateAtLeast(0.8);
        });
      }
    );

    const report = await runEvals();
    const result = report.results[0];
    expect(result).toMatchObject({
      assertions: [
        expect.objectContaining({
          failure: expect.stringContaining(
            "3 post-warmup run(s) ended with turn-error"
          ),
          passed: false,
        }),
      ],
      cache: {
        attemptedRequests: 4,
        cacheHitRate: 0.8,
        failedRequests: 3,
        successfulRequests: 1,
        telemetryCoverage: 0.25,
        trackedRequests: 1,
      },
      passed: false,
    });
    expect(report.failed).toBe(1);
  });

  it("does not let replayed usage satisfy the cache sample gate", async () => {
    clearEvals();
    defineEval(
      "cache-replayed-usage",
      { thread: duplicateUsageThread },
      (it) => {
        it("counts unique attempt ids", async (t) => {
          await t.run("hello");
          t.cacheHitRateAtLeast(0.8, { minTrackedRequests: 2 });
        });
      }
    );

    const result = (await runEvals()).results[0];
    expect(result).toMatchObject({
      assertions: [
        expect.objectContaining({
          failure: expect.stringContaining(
            "1 duplicate post-warmup model-usage record"
          ),
          passed: false,
        }),
      ],
      cache: {
        attemptedRequests: 1,
        cacheHitRate: 0.8,
        cacheReadTokens: 80,
        duplicateUsageRecords: 1,
        failedRequests: 0,
        inputTokens: 100,
        invalidPairedRequests: 0,
        successfulRequests: 1,
        telemetryCoverage: 1,
        trackedCacheReadTokens: 80,
        trackedInputTokens: 100,
        trackedRequests: 1,
      },
      passed: false,
    });
  });
});

function cacheTraceThread() {
  return new Agent({
    model: createMockLanguageModelV4([
      mockLanguageModelV4Text("one", cacheUsage(100, 0)),
      mockLanguageModelV4Text("two", cacheUsage(200, 160)),
      mockLanguageModelV4Text("three", cacheUsage(240, 210)),
    ]),
  }).thread("cache-trace");
}

function cacheUsage(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens = 0
): MockLanguageModelV4Usage {
  const outputTokens = 10;
  return {
    inputTokens: {
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      noCache: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
      total: inputTokens,
    },
    outputTokens: {
      reasoning: 4,
      text: outputTokens - 4,
      total: outputTokens,
    },
    raw: { privateProviderField: "provider-raw-secret" },
  };
}

function failedAttemptsThenSuccessThread(): EvalThreadLike {
  let run = 0;
  return {
    send() {
      const currentRun = run;
      run += 1;
      return Promise.resolve({
        async *events() {
          await Promise.resolve();
          yield { type: "turn-start" } as const;
          yield { type: "step-start" } as const;
          if (currentRun < 3) {
            yield {
              message: `provider failure ${currentRun + 1}`,
              type: "turn-error",
            } as const;
            return;
          }
          yield {
            attemptId: "attempt-success",
            cacheReadTokens: 80,
            inputTokens: 100,
            type: "model-usage",
          } as const;
          yield { type: "step-end" } as const;
          yield { type: "turn-end" } as const;
        },
      });
    },
  };
}

function duplicateUsageThread(): EvalThreadLike {
  return {
    send() {
      return Promise.resolve({
        async *events() {
          await Promise.resolve();
          yield { type: "turn-start" } as const;
          yield { type: "step-start" } as const;
          const usage = {
            attemptId: "attempt-replayed",
            cacheReadTokens: 80,
            inputTokens: 100,
            type: "model-usage",
          } as const;
          yield usage;
          yield usage;
          yield { type: "step-end" } as const;
          yield { type: "turn-end" } as const;
        },
      });
    },
  };
}

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
