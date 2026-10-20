import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../contracts/execution-store/fixtures";
import type { DurableObjectTransactionStorage } from "../storage/durable-object/durable-object-storage";
import { withTransaction } from "../storage/durable-object/sql-access";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";
import { createCelldScheduler, listCelldScheduledRuns } from "./scheduler";
import { ackCelldScheduledRun } from "./scheduler-claims";
import type { CelldDurableObjectStorage } from "./scheduler-support";

// createCelldSqliteTestStorage commits a transaction's own alarm writes on
// success, like Durable Object storage.
describe("Celld scheduling with transactions that only expose setAlarm", () => {
  it("enqueues and arms the earliest persisted due time", async () => {
    // Given
    const storage = setAlarmOnlyTransactions(createCelldSqliteTestStorage());
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    // When
    await scheduler.enqueueRun("late", { runAfterMs: 500 });
    await scheduler.enqueueRun("early", { runAfterMs: 100 });

    // Then
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 500 })
    ).resolves.toEqual(["early", "late"]);
    await expect(storage.getAlarm()).resolves.toBe(100);
  });

  it("does not postpone an earlier alarm already armed on the storage", async () => {
    // Given
    const storage = setAlarmOnlyTransactions(createCelldSqliteTestStorage());
    await storage.setAlarm(100);
    const scheduler = createCelldScheduler({ clock: () => 0, storage });

    // When
    await scheduler.enqueueRun("late", { runAfterMs: 500 });

    // Then
    await expect(storage.getAlarm()).resolves.toBe(100);
  });

  it("re-arms after acks and leaves an alarm it cannot delete transactionally", async () => {
    // Given
    const storage = setAlarmOnlyTransactions(createCelldSqliteTestStorage());
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("early", { runAfterMs: 100 });
    await scheduler.enqueueRun("late", { runAfterMs: 500 });

    // When
    await ackCelldScheduledRun(storage, "early");
    const alarmAfterFirstAck = await storage.getAlarm();
    await ackCelldScheduledRun(storage, "late");

    // Then the stale alarm only costs one empty drain
    expect(alarmAfterFirstAck).toBe(500);
    await expect(storage.getAlarm()).resolves.toBe(500);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: Number.MAX_SAFE_INTEGER })
    ).resolves.toEqual([]);
  });

  it("keeps an alarm a concurrent store transaction armed after the last ack", async () => {
    // Given
    const deleteEntered = createDeferred();
    const deleteGate = createDeferred();
    const storage = setAlarmOnlyTransactions(
      createCelldSqliteTestStorage({
        deleteAlarm: async () => {
          deleteEntered.resolve();
          await deleteGate.promise;
        },
      })
    );
    const scheduler = createCelldScheduler({ clock: () => 7, storage });
    await scheduler.enqueueRun("last", { runAfterMs: 500 });

    // When
    const ack = ackCelldScheduledRun(storage, "last");
    await Promise.race([ack, deleteEntered.promise]);
    await withTransaction(storage, (tx) =>
      scheduler.createTransactionScheduler(tx).enqueueRun("fresh")
    );
    deleteGate.resolve();
    await ack;

    // Then
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 7 })
    ).resolves.toEqual(["fresh"]);
    await expect(storage.getAlarm()).resolves.toBe(7);
  });
});

function setAlarmOnlyTransactions(
  storage: CelldDurableObjectStorage
): CelldDurableObjectStorage {
  return {
    ...storage,
    transaction: (operation) =>
      storage.transaction((transaction) =>
        operation({
          delete: transaction.delete,
          get: transaction.get,
          put: transaction.put,
          setAlarm: transaction.setAlarm,
          sql: transaction.sql,
        } satisfies DurableObjectTransactionStorage)
      ),
  };
}
