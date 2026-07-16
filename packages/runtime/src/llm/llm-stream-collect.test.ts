import type { ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  mockLanguageModelV4StreamError,
  mockLanguageModelV4StreamText,
  mockLanguageModelV4StreamToolCall,
  mockLanguageModelV4Text,
  mockLanguageModelV4ToolCall,
} from "../testing/mock-language-model-v4-test-utils";
import { generateModelStep } from "./llm";

const echoToolCall = {
  input: { city: "Seoul" },
  toolCallId: "call_echo_1",
  toolName: "echo",
} as const;

const echoTools = {
  echo: tool({
    description: "Echo test tool.",
    execute: (input) => ({ echoed: input }),
    inputSchema: jsonSchema({
      type: "object",
      properties: { city: { type: "string" } },
      additionalProperties: false,
    }),
  }),
} satisfies ToolSet;

describe("generateModelStep stream-collect transport (real streamText)", () => {
  it("collects streamed text into the same output as the generate transport", async () => {
    const generated = await generateModelStep({
      history: [{ role: "user", content: "hello" }],
      model: createMockLanguageModelV4([mockLanguageModelV4Text("done")]),
      signal: new AbortController().signal,
    });

    const streamed = await generateModelStep({
      history: [{ role: "user", content: "hello" }],
      model: createStreamingMockLanguageModelV4([
        mockLanguageModelV4StreamText("done"),
      ]),
      signal: new AbortController().signal,
      transport: "stream-collect",
    });

    expect(streamed).toEqual(generated);
  });

  it("collects streamed tool calls and executed tool results like the generate transport", async () => {
    const generated = await generateModelStep({
      history: [{ role: "user", content: "call the tool" }],
      model: createMockLanguageModelV4([
        mockLanguageModelV4ToolCall(echoToolCall),
      ]),
      signal: new AbortController().signal,
      tools: echoTools,
    });

    const streamed = await generateModelStep({
      history: [{ role: "user", content: "call the tool" }],
      model: createStreamingMockLanguageModelV4([
        mockLanguageModelV4StreamToolCall(echoToolCall),
      ]),
      signal: new AbortController().signal,
      tools: echoTools,
      transport: "stream-collect",
    });

    expect(streamed).toEqual(generated);
    const assistant = streamed.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      expect.objectContaining({
        input: echoToolCall.input,
        toolCallId: echoToolCall.toolCallId,
        toolName: echoToolCall.toolName,
        type: "tool-call",
      }),
    ]);
    const toolMessage = streamed.find((message) => message.role === "tool");
    expect(toolMessage?.content).toEqual([
      expect.objectContaining({
        output: { type: "json", value: { echoed: echoToolCall.input } },
        toolCallId: echoToolCall.toolCallId,
        type: "tool-result",
      }),
    ]);
  });

  it("surfaces the original model error exactly like the generate transport", async () => {
    const streamedFailure = new Error("gateway timed out");
    const generatedFailure = new Error("gateway timed out");

    await expect(
      generateModelStep({
        history: [{ role: "user", content: "hello" }],
        model: createStreamingMockLanguageModelV4([
          mockLanguageModelV4StreamError(streamedFailure),
        ]),
        signal: new AbortController().signal,
        transport: "stream-collect",
      })
    ).rejects.toBe(streamedFailure);

    await expect(
      generateModelStep({
        history: [{ role: "user", content: "hello" }],
        model: createMockLanguageModelV4(() => {
          throw generatedFailure;
        }),
        signal: new AbortController().signal,
      })
    ).rejects.toBe(generatedFailure);
  });
});
