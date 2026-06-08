import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  isControlAgentEvent,
  isLifecycleAgentEvent,
  isSubagentStatusAgentEvent,
  isTelemetryAgentEvent,
  isToolAgentEvent,
  isVisibleAgentEvent,
} from "./events";

const sessionImplementationImportPattern = /from "\.\/session"/;
const recursiveEventPayloadPattern = /\|\s*\{[^}]*\bevent\??:\s*AgentEvent\b/s;
const eventsSourceUrl = new URL("./events.ts", import.meta.url);

const readEventsSource = () => readFile(eventsSourceUrl, "utf8");

describe("session event protocol boundary", () => {
  it("does not depend on the session implementation module", async () => {
    const source = await readEventsSource();

    expect(source).not.toMatch(sessionImplementationImportPattern);
  });

  it("uses non-recursive subagent lifecycle event payloads", async () => {
    const source = await readEventsSource();

    expect(source).toContain('type: "subagent-job-start"');
    expect(source).toContain('type: "subagent-job-update"');
    expect(source).toContain('type: "subagent-job-end"');
    expect(source).toContain('eventType?: AgentEvent["type"]');
    expect(source).not.toMatch(recursiveEventPayloadPattern);
  });

  it("classifies public event stream categories with type guards", () => {
    const events = [
      { text: "shown", type: "assistant-text" },
      { type: "turn-start" },
      {
        input: { value: 1 },
        toolCallId: "tool-1",
        toolName: "lookup",
        type: "tool-call",
      },
      {
        run_in_background: true,
        subagent: "worker",
        type: "subagent-job-start",
      },
      { text: "internal reasoning", type: "assistant-reasoning" },
    ] satisfies readonly AgentEvent[];

    expect(events.filter(isVisibleAgentEvent)).toEqual([events[0]]);
    expect(events.filter(isLifecycleAgentEvent)).toEqual([events[1]]);
    expect(events.filter(isToolAgentEvent)).toEqual([events[2]]);
    expect(events.filter(isSubagentStatusAgentEvent)).toEqual([events[3]]);
    expect(events.filter(isTelemetryAgentEvent)).toEqual([events[4]]);
    expect(events.filter(isControlAgentEvent)).toEqual(events.slice(1));
  });
});
