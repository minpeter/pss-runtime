import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../contracts/execution-store/fixtures";
import { InMemoryDurableObjectStorage } from "../storage/durable-object/durable-object-storage";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";
import { createCelldTestStorage } from "./celld-test-storage";
import type { CelldDurableObjectStorage } from "./scheduler-support";

function inMemoryCelldStorage(): CelldDurableObjectStorage {
  const storage = new InMemoryDurableObjectStorage();
  return {
    delete: (key) => storage.delete(key),
    deleteAlarm: () => Promise.reject(new Error("unused")),
    get: (key) => storage.get(key),
    getAlarm: () => Promise.resolve(storage.alarmTime()?.valueOf() ?? null),
    put: (key, value) => storage.put(key, value),
    setAlarm: (scheduledTime) => storage.setAlarm(scheduledTime),
    sql: storage.sql,
    transaction: (operation) => storage.transaction(operation),
  };
}

// Durable Object storage commits only the alarm writes a transaction made; an
// alarm set outside it while it was open must survive its commit.
describe.each([
  ["createCelldSqliteTestStorage", () => createCelldSqliteTestStorage()],
  ["createCelldTestStorage", () => createCelldTestStorage()],
  ["InMemoryDurableObjectStorage", inMemoryCelldStorage],
] as const)("%s transaction alarm commit", (_name, createStorage) => {
  it("keeps an alarm set outside an open transaction that never wrote one", async () => {
    // Given
    const storage = createStorage();
    const entered = createDeferred();
    const gate = createDeferred();
    const transaction = storage.transaction(async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;

    // When
    await storage.setAlarm(5);
    gate.resolve();
    await transaction;

    // Then
    await expect(storage.getAlarm()).resolves.toBe(5);
  });

  it("commits the alarm a transaction wrote and drops it on rollback", async () => {
    // Given
    const storage = createStorage();
    await storage.setAlarm(5);

    // When
    await storage.transaction(async (tx) => {
      await tx.setAlarm?.(9);
    });
    const committed = await storage.getAlarm();
    await expect(
      storage.transaction(async (tx) => {
        await tx.setAlarm?.(1);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");

    // Then
    expect(committed).toBe(9);
    await expect(storage.getAlarm()).resolves.toBe(9);
  });
});
