import { describe, expect, it } from "vitest";
import { createCelldTestStorage } from "./celld-test-storage";

describe("createCelldTestStorage transaction alarm commit", () => {
  it("keeps an alarm set outside an open transaction that never wrote one", async () => {
    // Given
    const storage = createCelldTestStorage();
    let markEntered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = storage.transaction(async () => {
      markEntered();
      await gate;
    });
    await entered;

    // When
    await storage.setAlarm(5);
    release();
    await transaction;

    // Then
    await expect(storage.getAlarm()).resolves.toBe(5);
  });

  it("commits the alarm a transaction wrote and drops it on rollback", async () => {
    // Given
    const storage = createCelldTestStorage();
    await storage.setAlarm(5);

    // When
    await storage.transaction(async (tx) => {
      await tx.setAlarm?.(9);
    });
    await expect(
      storage.transaction(async (tx) => {
        await tx.setAlarm?.(1);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");

    // Then
    await expect(storage.getAlarm()).resolves.toBe(9);
  });
});
