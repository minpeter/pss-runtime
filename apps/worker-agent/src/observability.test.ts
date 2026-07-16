import type { PluginAPI, PluginEventContext } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";

import {
  createTurnEventCollector,
  createTurnObservabilityPlugin,
  describeEvent,
  type TurnObservabilityEntry,
} from "./observability";

describe("describeEvent", () => {
  it("captures tool events with the tool name", () => {
    expect(
      describeEvent(
        { type: "tool-call", input: {}, toolCallId: "1", toolName: "search" },
        "production"
      )
    ).toEqual({ event: "tool-call", label: "production", toolName: "search" });
  });

  it("captures turn-error with its message", () => {
    expect(
      describeEvent({ type: "turn-error", message: "boom" }, "dev")
    ).toEqual({ event: "turn-error", label: "dev", message: "boom" });
  });

  it("captures lifecycle events without text payloads", () => {
    expect(describeEvent({ type: "turn-end" })).toEqual({ event: "turn-end" });
  });

  it("ignores user-authored text events to avoid leaking content", () => {
    expect(
      describeEvent({ type: "user-input", text: "secret" })
    ).toBeUndefined();
    expect(
      describeEvent({ type: "assistant-output", text: "secret" })
    ).toBeUndefined();
  });
});

describe("createTurnEventCollector", () => {
  it("summarizes steps and tool calls for a wide event", () => {
    const collector = createTurnEventCollector();
    collector.record({ event: "turn-start", label: "dev" });
    collector.record({ event: "step-start", label: "dev" });
    collector.record({
      event: "tool-call",
      label: "dev",
      toolName: "send_message",
    });
    collector.record({ event: "step-end", label: "dev" });
    collector.record({ event: "turn-end", label: "dev" });

    expect(collector.summary()).toEqual({
      errors: [],
      steps: 1,
      toolCalls: ["send_message"],
    });
  });
});

describe("createTurnObservabilityPlugin", () => {
  it("logs described events through the provided sink and never intercepts", async () => {
    const entries: TurnObservabilityEntry[] = [];
    const plugin = createTurnObservabilityPlugin({
      label: "dev",
      log: (entry) => entries.push(entry),
    });
    const handlers = new Map<
      string,
      (event: unknown, context: PluginEventContext) => unknown
    >();
    await plugin(
      {
        on: (event, handler) => {
          handlers.set(
            event,
            handler as (event: unknown, context: PluginEventContext) => unknown
          );
          return { unsubscribe: () => undefined };
        },
        provide: () => {
          throw new Error("not used");
        },
      } as PluginAPI,
      { signal: new AbortController().signal }
    );
    const context: PluginEventContext = {
      history: [],
      signal: new AbortController().signal,
      thread: { key: "test" },
    };

    const toolResult = await handlers.get("tool.execution.end")?.(
      {
        type: "tool-result",
        output: {},
        toolCallId: "1",
        toolName: "x",
      },
      context
    );
    const userInput = await handlers.get("message.update")?.(
      { type: "assistant-output", text: "hi" },
      context
    );

    expect(toolResult).toBeUndefined();
    expect(userInput).toBeUndefined();
    expect(entries).toEqual([
      { event: "tool-result", label: "dev", toolName: "x" },
    ]);
  });
});
