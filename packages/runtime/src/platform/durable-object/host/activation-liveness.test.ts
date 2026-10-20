import { describe, expect, it } from "vitest";
import { createAgent } from "../../../agent/core/agent";
import { TURN_LEASE_MS } from "../../../execution/host/lease-owner";
import { createThreadExecutionRunId } from "../../../execution/host/thread-execution-run-id";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
} from "../../../testing/test-fixtures";
import { collect } from "../../../thread/handle/test-support";
import { encodeThreadSnapshot } from "../../../thread/state/snapshot";
import { InMemoryDurableObjectStorage } from "../storage/durable-object/durable-object-storage";
import { createDurableObjectStorageHost } from "./storage-host";

describe("Durable Object lease owners", () => {
  it("continues at once a run that an earlier activation left leased", async () => {
    // Given: a run still leased by the activation that ran it before the
    // object restarted.
    const host = createDurableObjectStorageHost({
      storage: new InMemoryDurableObjectStorage(),
    });
    const threadKey = "restarted-object";
    await host.store.threads.commit(
      threadKey,
      { state: encodeThreadSnapshot([{ content: "go", role: "user" }]) },
      { expectedVersion: null }
    );
    const runId = createThreadExecutionRunId({ threadKey, turnId: "crashed" });
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      lease: {
        attempt: 1,
        leaseId: "earlier-lease",
        leaseUntilMs: Date.now() + TURN_LEASE_MS,
        owner: { id: "earlier-activation" },
      },
      rootRunId: runId,
      runId,
      status: "running",
      threadKey,
    });
    const agent = await createAgent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    // When: the new activation continues the thread.
    const turn = await agent.thread(threadKey).continue();

    // Then: it takes the run over without waiting for the lease.
    expect(eventTypes(await collect(turn ?? never()))).toContain("turn-end");
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "completed",
    });
  });
});

function never(): never {
  throw new Error("Expected the run to continue.");
}
