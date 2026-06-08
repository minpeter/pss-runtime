import { describe, expect, it } from "vitest";
import { Agent } from "./agent";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, RunStore } from "./execution/types";

describe("durable subagent child cleanup failures", () => {
  it("evicts the parent handle when durable child cancellation fails", async () => {
    const host = createListRejectingHost();
    const agent = new Agent({
      host,
      model: async () => [],
      namespace: "cleanup-delete-failure",
    });
    const firstSession = agent.session("default");

    await expect(firstSession.delete()).rejects.toThrow(
      "durable child cancellation failed"
    );

    expect(agent.session("default")).not.toBe(firstSession);
  });
});

function createListRejectingHost(): ExecutionHost {
  const base = createInMemoryExecutionHost();
  const runs: RunStore = {
    claim: (runId, options) => base.store.runs.claim(runId, options),
    create: (record) => base.store.runs.create(record),
    get: (runId) => base.store.runs.get(runId),
    getByDedupeKey: (dedupeKey) => base.store.runs.getByDedupeKey(dedupeKey),
    listByParentRunId: () =>
      Promise.reject(new Error("durable child cancellation failed")),
    update: (record) => base.store.runs.update(record),
  };

  return {
    ...base,
    store: {
      checkpoints: base.store.checkpoints,
      events: base.store.events,
      notifications: base.store.notifications,
      runs,
      sessions: base.store.sessions,
      transaction: (fn) => base.store.transaction(fn),
    },
  };
}
