import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  isControlAgentEvent,
  isLifecycleAgentEvent,
  isTelemetryAgentEvent,
  isToolAgentEvent,
  isVisibleAgentEvent,
} from "./events";

const threadImplementationImportPattern = /from "\.\/thread"/;
const eventsSourceUrl = new URL("./events.ts", import.meta.url);
const forbiddenSubagentEventSurface = [
  [["sub", "agent"].join(""), "job", "start"].join("-"),
  [["sub", "agent"].join(""), "job", "update"].join("-"),
  [["sub", "agent"].join(""), "job", "end"].join("-"),
  ["Subagent", "Status", "Agent", "Event"].join(""),
  ["is", "Subagent", "Status", "Agent", "Event"].join(""),
] as const;

const readEventsSource = () => readFile(eventsSourceUrl, "utf8");

describe("thread event protocol boundary", () => {
  it("does not depend on the thread implementation module", async () => {
    const source = await readEventsSource();

    expect(source).not.toMatch(threadImplementationImportPattern);
  });

  it("omits runtime-owned subagent lifecycle event payloads", async () => {
    const source = await readEventsSource();

    for (const forbiddenName of forbiddenSubagentEventSurface) {
      expect(source).not.toContain(forbiddenName);
    }
  });

  it("classifies public event stream categories with type guards", () => {
    const events = [
      { text: "shown", type: "assistant-output" },
      { type: "turn-start" },
      {
        input: { value: 1 },
        toolCallId: "tool-1",
        toolName: "lookup",
        type: "tool-call",
      },
      {
        text: "internal reasoning",
        type: "assistant-reasoning",
      },
      {
        attemptId: "attempt-telemetry",
        cacheReadTokens: 80,
        inputTokens: 100,
        type: "model-usage",
      },
    ] satisfies readonly AgentEvent[];

    expect(events.filter(isVisibleAgentEvent)).toEqual([events[0]]);
    expect(events.filter(isLifecycleAgentEvent)).toEqual([events[1]]);
    expect(events.filter(isToolAgentEvent)).toEqual([events[2]]);
    expect(events.filter(isTelemetryAgentEvent)).toEqual([
      events[3],
      events[4],
    ]);
    expect(events.filter(isControlAgentEvent)).toEqual(events.slice(1));
  });
});
