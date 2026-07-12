import { describe, expect, it } from "vitest";

import {
  createTurnEventCollector,
  createTurnObservabilityPlugin,
  describeEvent,
  type TurnObservabilityEntry,
} from "./observability";

const HISTORY = [] as const;

describe("describeEvent", () => {
  it("captures tool events with the tool name", () => {
    expect(
      describeEvent(
        { type: "tool-call", input: {}, toolCallId: "1", toolName: "search" },
        "production"
      )
    ).toEqual({ event: "tool-call", label: "production", toolName: "search" });
  });

  it("captures tool-result execute errors without dumping success payloads", () => {
    expect(
      describeEvent({
        type: "tool-result",
        output: {
          type: "error-text",
          value:
            "TypeError: Illegal invocation: function called with incorrect `this` reference.",
        },
        toolCallId: "1",
        toolName: "web_search",
      })
    ).toEqual({
      event: "tool-result",
      message:
        "TypeError: Illegal invocation: function called with incorrect `this` reference.",
      toolName: "web_search",
    });

    expect(
      describeEvent({
        type: "tool-result",
        output: { type: "json", value: { ok: true, resultCount: 3 } },
        toolCallId: "2",
        toolName: "web_search",
      })
    ).toEqual({ event: "tool-result", toolName: "web_search" });
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

  it("includes toolpick selections when recorded", () => {
    const collector = createTurnEventCollector();
    collector.recordToolpick({
      activeTools: ["send_message"],
      reason: "hybrid",
      stepNumber: 0,
    });

    expect(collector.summary().toolpick).toEqual([
      {
        activeTools: ["send_message"],
        reason: "hybrid",
        stepNumber: 0,
      },
    ]);
  });

  it("records tool-result errors for the wide event", () => {
    const collector = createTurnEventCollector();
    collector.record({
      event: "tool-result",
      message: "TypeError: Illegal invocation",
      toolName: "web_search",
    });

    expect(collector.summary().errors).toEqual([
      "web_search: TypeError: Illegal invocation",
    ]);
  });
});

describe("createTurnObservabilityPlugin", () => {
  it("logs described events through the provided sink and never intercepts", async () => {
    const entries: TurnObservabilityEntry[] = [];
    const plugin = createTurnObservabilityPlugin({
      label: "dev",
      log: (entry) => entries.push(entry),
    });

    const toolResult = await plugin.on?.({
      event: {
        type: "tool-result",
        output: {},
        toolCallId: "1",
        toolName: "x",
      },
      history: HISTORY,
    });
    const userInput = await plugin.on?.({
      event: { type: "assistant-output", text: "hi" },
      history: HISTORY,
    });

    expect(toolResult).toBeUndefined();
    expect(userInput).toBeUndefined();
    expect(entries).toEqual([
      { event: "tool-result", label: "dev", toolName: "x" },
    ]);
  });
});
