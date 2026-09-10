import { jsonSchema, type Tool, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { readModelOutput } from "../agent/loop/step-output";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import { failedRequestMessages } from "./failed-request";
import { generateModelStepResult } from "./model-step";
import { normalizeToolCallIds } from "./tool-execution-wrapper";
import { ToolStepProgress } from "./tool-step-progress";

it("retains request metadata on a function-valued provider exception", async () => {
  const failure = () => undefined;
  const error = await generateModelStepResult({
    history: [{ role: "user", content: "INPUT" }],
    signal: new AbortController().signal,
    model: createMockLanguageModelV4(() => {
      throw failure;
    }),
  }).catch((cause: unknown) => cause);
  expect(error).toBe(failure);
  expect(failedRequestMessages(error)).toEqual([]);
  expect(failedRequestMessages(error)).toBeUndefined();
});

describe("cancellation classification", () => {
  it.each(["callback", "transform"] as const)(
    "does not swallow an unrelated %s failure after cancellation",
    async (boundary) => {
      const controller = new AbortController();
      const failure = new Error("UNRELATED_FAILURE");
      const fail = () => {
        controller.abort();
        throw failure;
      };
      await expect(
        readModelOutput({
          history: {
            appendModelMessage: vi.fn(),
            modelSnapshot: () => [],
            modelContextSnapshot: () => [{ role: "user", content: "INPUT" }],
          },
          model: {
            model: createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]),
          },
          runtimeStepIndex: 0,
          signal: controller.signal,
          ...(boundary === "callback"
            ? {
                onStreamEvent: (event) => {
                  if (event.type === "assistant-output-delta") {
                    fail();
                  }
                },
              }
            : { transformModelContext: async () => fail() }),
        })
      ).rejects.toBe(failure);
    }
  );
  it("returns aborted when the context transform observes cancellation", async () => {
    const controller = new AbortController();
    const model = vi.fn(() =>
      Promise.resolve(mockLanguageModelV4Text("UNEXPECTED"))
    );
    await expect(
      readModelOutput({
        history: {
          appendModelMessage: vi.fn(),
          modelSnapshot: () => [],
          modelContextSnapshot: () => [],
        },
        model: { model: createMockLanguageModelV4(model) },
        runtimeStepIndex: 0,
        signal: controller.signal,
        transformModelContext: (_messages, signal) => {
          controller.abort();
          signal.throwIfAborted();
          return Promise.resolve([]);
        },
      })
    ).resolves.toBe("aborted");
    expect(model).not.toHaveBeenCalled();
  });
});

it("recovers the executed input and structured tool output", async () => {
  const progress = new ToolStepProgress();
  const input = { value: "TRANSFORMED" };
  const output = { accepted: true, values: [1, null] };
  const execute = vi.fn(() => output);
  const tools = normalizeToolCallIds(
    {
      effect: tool({ inputSchema: jsonSchema({ type: "object" }), execute }),
    },
    new Map(),
    {
      attempt: 1,
      runId: "run",
      beforeTool: () => ({ status: "continue", input }),
    },
    progress
  );
  const effect = tools?.effect as Tool<{ value: string }>;
  expect(effect.execute).toBeTypeOf("function");
  await effect.execute?.(
    { value: "ORIGINAL" },
    { toolCallId: "call_effect", messages: [], context: undefined }
  );
  expect(execute).toHaveBeenCalledWith(input, expect.anything());
  expect(progress.recover()).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_effect",
          toolName: "effect",
          input,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_effect",
          toolName: "effect",
          output: { type: "json", value: output },
        },
      ],
    },
  ]);
});

it.each([
  "TEXT",
  { nested: [1, null, true] },
  ["ARRAY"],
  7,
  false,
  null,
  undefined,
])("matches the SDK's default model-output contract for %j", async (output) => {
  const progress = new ToolStepProgress();
  const result = await generateModelStepResult({
    history: [{ role: "user", content: "INPUT" }],
    signal: new AbortController().signal,
    model: createMockLanguageModelV4([
      {
        ...mockLanguageModelV4Text(""),
        content: [
          {
            type: "tool-call",
            toolCallId: "call_parity",
            toolName: "effect",
            input: "{}",
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
      },
    ]),
    tools: {
      effect: tool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: () => output,
      }),
    },
  });
  progress.begin({}, "call_parity", "effect").complete(output);
  expect(progress.recover()).toEqual(result.messages);
});
