import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";
import { collectSubagentRunWithEvents } from "./subagent-run";

describe("subagent run collection", () => {
  it("returns a compact error result when the child event stream rejects", async () => {
    async function* events() {
      await Promise.resolve();
      const event = {
        text: "partial",
        type: "assistant-text",
      } satisfies AgentEvent;
      yield event;
      throw new Error("stream failed");
    }

    const run: AgentRun = {
      events,
    };

    await expect(
      collectSubagentRunWithEvents(run, "researcher")
    ).resolves.toEqual({
      events: [{ text: "partial", type: "assistant-text" }],
      result: {
        error: "stream failed",
        eventCount: 1,
        result: "error",
        run_in_background: false,
        subagent: "researcher",
        text: "partial",
      },
    });
  });

  it("bounds retained child events while preserving event count and compact text", async () => {
    async function* events() {
      await Promise.resolve();
      for (let index = 0; index < 250; index += 1) {
        yield {
          text: "x",
          type: "assistant-text",
        } satisfies AgentEvent;
      }
    }

    const run: AgentRun = {
      events,
    };

    const collected = await collectSubagentRunWithEvents(run, "researcher");

    expect(collected.events).toHaveLength(200);
    expect(collected.result).toEqual({
      eventCount: 250,
      result: "completed",
      run_in_background: false,
      subagent: "researcher",
      text: "x".repeat(250),
    });
  });

  it("marks compact child text when it is truncated", async () => {
    async function* events() {
      await Promise.resolve();
      yield {
        text: "x".repeat(20_001),
        type: "assistant-text",
      } satisfies AgentEvent;
    }

    const run: AgentRun = {
      events,
    };

    const collected = await collectSubagentRunWithEvents(run, "researcher");

    expect(collected.result.text).toBe(`${"x".repeat(20_000)}…[truncated]`);
  });
});
