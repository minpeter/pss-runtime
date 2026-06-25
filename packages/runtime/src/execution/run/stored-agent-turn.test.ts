import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "../../platform/memory";
import type { AgentEvent } from "../../thread/protocol/events";
import { StoredAgentTurn } from "./stored-agent-turn";

async function collectRunEvents(run: StoredAgentTurn): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

describe("stored AgentTurn events", () => {
  it("replays stored events from cursor without thread runs", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: "run-1",
      runId: "run-1",
      threadKey: "thread-1",
      status: "queued",
    });
    const cursor = await host.store.events.append("run-1", {
      type: "turn-start",
    });
    await host.store.events.append("run-1", { type: "turn-end" });

    const run = new StoredAgentTurn({
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
    const run = new StoredAgentTurn({
      eventStore: host.store.events,
      runId: "run-1",
    });

    run.events();

    expect(() => run.events()).toThrow(
      "AgentTurn.events() can only be consumed once"
    );
  });
});
