import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../contracts/execution-store/fixtures";
import { withTransaction } from "../storage/durable-object/sql-access";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";
import { createCelldHost } from "./host";
import { createCelldScheduler, listCelldScheduledRuns } from "./scheduler";
import {
  ackCelldScheduledRun,
  rearmCelldScheduledWork,
} from "./scheduler-claims";

// Each test pauses a re-arm mid-flight, starts a store transaction that
// enqueues work, and releases the re-arm only once that transaction has either
// committed (re-arm outside a transaction) or queued behind it (re-arm inside
// one), so both interleavings are forced without timers.
describe("Celld alarm re-arm racing a store transaction", () => {
  it("keeps the alarm a transaction armed while an ack re-arm is paused in deleteAlarm", async () => {
    // Given
    const deleteEntered = createDeferred();
    const deleteGate = createDeferred();
    const queued = createDeferred();
    const storage = createCelldSqliteTestStorage({
      deleteAlarm: async () => {
        deleteEntered.resolve();
        await deleteGate.promise;
      },
      transactionQueued: () => queued.resolve(),
    });
    const scheduler = createCelldScheduler({ clock: () => 7, storage });
    await scheduler.enqueueRun("acked");

    // When
    const ack = ackCelldScheduledRun(storage, "acked");
    await deleteEntered.promise;
    const enqueue = withTransaction(storage, (tx) =>
      scheduler.createTransactionScheduler(tx).enqueueRun("fresh")
    );
    await Promise.race([enqueue, queued.promise]);
    deleteGate.resolve();
    await Promise.all([ack, enqueue]);

    // Then
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 7 })
    ).resolves.toEqual(["fresh"]);
    await expect(storage.getAlarm()).resolves.toBe(7);
  });

  it("does not postpone a transaction's earlier alarm with a re-arm that read stale rows", async () => {
    // Given
    let pauseNextGetAlarm = false;
    const getEntered = createDeferred();
    const getGate = createDeferred();
    const queued = createDeferred();
    const storage = createCelldSqliteTestStorage({
      getAlarm: async () => {
        if (!pauseNextGetAlarm) {
          return;
        }
        pauseNextGetAlarm = false;
        getEntered.resolve();
        await getGate.promise;
      },
      transactionQueued: () => queued.resolve(),
    });
    let nowMs = 0;
    const scheduler = createCelldScheduler({ clock: () => nowMs, storage });
    await scheduler.enqueueRun("late", { runAfterMs: 500 });
    nowMs = 10;

    // When
    pauseNextGetAlarm = true;
    const rearm = rearmCelldScheduledWork(storage);
    await getEntered.promise;
    const enqueue = withTransaction(storage, (tx) =>
      scheduler.createTransactionScheduler(tx).enqueueRun("now")
    );
    await Promise.race([enqueue, queued.promise]);
    getGate.resolve();
    await Promise.all([rearm, enqueue]);

    // Then
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 10 })
    ).resolves.toEqual(["now"]);
    await expect(storage.getAlarm()).resolves.toBe(10);
  });

  it("keeps the first tx.scheduler alarm when host activation re-arm races it", async () => {
    // Given
    const deleteEntered = createDeferred();
    const deleteGate = createDeferred();
    const queued = createDeferred();
    const storage = createCelldSqliteTestStorage({
      deleteAlarm: async () => {
        deleteEntered.resolve();
        await deleteGate.promise;
      },
      transactionQueued: () => queued.resolve(),
    });
    await storage.setAlarm(99);
    const activation: Promise<unknown>[] = [];
    const host = createCelldHost({
      clock: () => 3,
      state: {
        storage,
        waitUntil: (promise) => {
          activation.push(promise);
        },
      },
    });

    // When
    await deleteEntered.promise;
    const enqueue = host.store.transaction(async (tx) => {
      await tx.scheduler?.enqueueRun("first");
    });
    await Promise.race([enqueue, queued.promise]);
    deleteGate.resolve();
    await Promise.all([...activation, enqueue]);

    // Then
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 3 })
    ).resolves.toEqual(["first"]);
    await expect(storage.getAlarm()).resolves.toBe(3);
  });
});
