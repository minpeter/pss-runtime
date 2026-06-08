import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import { StoredAgentRun } from "./execution/run";
import type { AgentEvent } from "./session/events";

async function collectRunEvents(run: StoredAgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

describe("stored AgentRun events", () => {
  it("replays stored events from cursor without session runs", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.runs.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: "run-1",
      runId: "run-1",
      sessionKey: "session-1",
      status: "queued",
    });
    const cursor = await host.store.events.append("run-1", {
      type: "turn-start",
    });
    await host.store.events.append("run-1", { type: "turn-end" });

    const run = new StoredAgentRun({
      cursor,
      eventStore: host.store.events,
      runId: "run-1",
    });

    await expect(collectRunEvents(run)).resolves.toEqual([
      { type: "turn-end" },
    ]);
  });

  it("rejects concurrent event iteration for one run", () => {
    const host = createInMemoryExecutionHost();
    const run = new StoredAgentRun({
      eventStore: host.store.events,
      runId: "run-1",
    });

    run.events();

    expect(() => run.events()).toThrow(
      "AgentRun.events() can only be consumed once"
    );
  });
});
