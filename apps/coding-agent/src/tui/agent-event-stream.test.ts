import type { AgentEvent, ModelUsage } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { agentEventStreamParts } from "./agent-event-stream";
import type { TuiStreamPart } from "./stream-handlers";

const collect = async (
  events: AgentEvent[],
  options?: { onModelUsage?: (usage: ModelUsage) => void }
): Promise<TuiStreamPart[]> => {
  const parts: TuiStreamPart[] = [];
  const source = (async function* () {
    yield* events;
  })();
  for await (const part of agentEventStreamParts(source, options)) {
    parts.push(part);
  }
  return parts;
};

describe("agentEventStreamParts", () => {
  it("brackets assistant text with text-start/text-delta/text-end", async () => {
    const parts = await collect([
      { type: "assistant-output", text: "hello world" },
    ]);

    expect(parts).toEqual([
      { type: "text-start" },
      { type: "text-delta", text: "hello world" },
      { type: "text-end" },
    ]);
  });

  it("brackets reasoning with reasoning-start/delta/end", async () => {
    const parts = await collect([
      { type: "assistant-reasoning", text: "thinking" },
    ]);

    expect(parts).toEqual([
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "thinking" },
      { type: "reasoning-end" },
    ]);
  });

  it("maps tool calls and results to their stream parts", async () => {
    const parts = await collect([
      {
        type: "tool-call",
        input: { command: "ls" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
      {
        type: "tool-result",
        output: "ok",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-call",
        input: { command: "ls" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
      {
        type: "tool-result",
        output: "ok",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);
  });

  it("routes error-shaped tool outputs to tool-error parts", async () => {
    const parts = await collect([
      {
        type: "tool-result",
        output: { type: "error-text", value: "boom" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-error",
        error: "boom",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);
  });

  it("unwraps text-typed tool outputs to the raw string", async () => {
    const parts = await collect([
      {
        type: "tool-result",
        output: { type: "text", value: "OK - command finished\nexit_code: 0" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-result",
        output: "OK - command finished\nexit_code: 0",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);
  });

  it("unwraps json-typed tool outputs to the raw value", async () => {
    const results = [{ title: "t", url: "https://a.dev" }];
    const parts = await collect([
      {
        type: "tool-result",
        output: { type: "json", value: results },
        toolCallId: "call_1",
        toolName: "web_search",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-result",
        output: results,
        toolCallId: "call_1",
        toolName: "web_search",
      },
    ]);
  });

  it("maps execution-denied outputs to tool-output-denied parts", async () => {
    const parts = await collect([
      {
        type: "tool-result",
        output: { type: "execution-denied", reason: "policy" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-output-denied",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);
  });

  it("forwards model-usage to the callback and tracks the last finish reason", async () => {
    const onModelUsage = vi.fn();
    const parts = await collect(
      [
        {
          type: "model-usage",
          attemptId: "a1",
          finishReason: "stop",
          inputTokens: 10,
          outputTokens: 5,
        },
        { type: "step-end" },
        { type: "turn-end" },
      ],
      { onModelUsage }
    );

    expect(onModelUsage).toHaveBeenCalledTimes(1);
    expect(parts).toEqual([
      { type: "finish-step", finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("defaults the finish reason to stop when no usage was reported", async () => {
    const parts = await collect([{ type: "turn-end" }]);
    expect(parts).toEqual([{ type: "finish", finishReason: "stop" }]);
  });

  it("maps turn lifecycle events to start/abort/error parts", async () => {
    const parts = await collect([
      { type: "turn-start" },
      { type: "step-start" },
      { type: "turn-abort" },
    ]);

    expect(parts).toEqual([
      { type: "start" },
      { type: "start-step" },
      { type: "abort", reason: "interrupted" },
    ]);

    const errorParts = await collect([
      { type: "turn-error", message: "model exploded" },
    ]);
    expect(errorParts).toEqual([{ type: "error", error: "model exploded" }]);
  });

  it("skips user-input and runtime-input echoes", async () => {
    const parts = await collect([
      { type: "user-input", text: "hi" } as AgentEvent,
      { type: "assistant-output", text: "hello" },
    ]);

    expect(parts).toEqual([
      { type: "text-start" },
      { type: "text-delta", text: "hello" },
      { type: "text-end" },
    ]);
  });
});
