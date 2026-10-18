import { describe, expect, it } from "vitest";
import type { DurableObjectTransactionStorage } from "../storage/durable-object/durable-object-storage";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";
import { createCelldScheduler, listCelldScheduledRuns } from "./scheduler";
import { ackCelldScheduledRun } from "./scheduler-claims";
import type { CelldDurableObjectStorage } from "./scheduler-support";

// createCelldSqliteTestStorage buffers a transaction's alarm and commits it on
// success, like Durable Object storage, so an outer-storage alarm write made
// inside a transaction would be overwritten by the commit.
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

  it("re-arms and clears the storage alarm after acks commit", async () => {
    // Given
    const storage = setAlarmOnlyTransactions(createCelldSqliteTestStorage());
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("early", { runAfterMs: 100 });
    await scheduler.enqueueRun("late", { runAfterMs: 500 });

    // When
    await ackCelldScheduledRun(storage, "early");
    const alarmAfterFirstAck = await storage.getAlarm();
    await ackCelldScheduledRun(storage, "late");

    // Then
    expect(alarmAfterFirstAck).toBe(500);
    await expect(storage.getAlarm()).resolves.toBeNull();
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
