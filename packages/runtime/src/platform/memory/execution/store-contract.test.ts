import { describe, expect, it } from "vitest";
import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import {
  createDeferred,
  createQueuedRun,
} from "../../../contracts/execution-store/fixtures";
import { createInMemoryHost, type InMemoryHost } from "./execution-host";

const hostSchedulers = new WeakMap<object, InMemoryHost["scheduler"]>();

describeExecutionStoreContract({
  createStore: () => {
    const host = createInMemoryHost();
    hostSchedulers.set(host.store, host.scheduler);
    return host.store;
  },
  name: "InMemoryExecutionStore",
  transactionalScheduler: {
    listScheduledRuns: (store) =>
      hostSchedulers.get(store)?.listScheduledRuns() ?? Promise.resolve([]),
  },
});

describe("InMemoryExecutionStore transaction isolation", () => {
  it("serializes direct run claims behind a terminal transaction write", async () => {
    // Given: a transaction has updated a queued run to terminal state but has not committed.
    const store = createInMemoryHost().store;
    const runId = "run-transaction-isolation";
    await store.turns.create(createQueuedRun(runId));
    const transactionUpdated = createDeferred();
    const releaseTransaction = createDeferred();
    const transaction = store.transaction(async (tx) => {
      const run = await tx.turns.get(runId);
      if (!run) {
        throw new Error("Expected the queued run inside the transaction.");
      }
      await tx.turns.update({ ...run, status: "completed" });
      transactionUpdated.resolve();
      await releaseTransaction.promise;
    });
    await transactionUpdated.promise;

    // When: a public claim races the paused transaction, then the transaction is released.
    const claim = store.turns.claim(runId, {
      attempt: 1,
      leaseId: "lease-after-terminal-write",
      leaseMs: 100,
      nowMs: 0,
    });
    releaseTransaction.resolve();
    await transaction;

    // Then: the terminal commit wins serialization and the later claim observes it.
    await expect(store.turns.get(runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(claim).resolves.toEqual({
      ok: false,
      reason: "not-claimable",
    });
  });
});
