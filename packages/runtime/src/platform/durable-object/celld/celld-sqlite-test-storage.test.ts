import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../contracts/execution-store/fixtures";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";

describe("createCelldSqliteTestStorage", () => {
  it("keeps later transactions runnable after a throwing transactionQueued hook", async () => {
    // Given
    const hookFailure = new Error("queued hook failure");
    let failHook = true;
    const storage = createCelldSqliteTestStorage({
      transactionQueued: () => {
        if (failHook) {
          failHook = false;
          throw hookFailure;
        }
      },
    });
    const firstEntered = createDeferred();
    const firstGate = createDeferred();
    const first = storage.transaction(async () => {
      firstEntered.resolve();
      await firstGate.promise;
    });
    await firstEntered.promise;

    // When
    const failed = storage.transaction(() => Promise.resolve("unreachable"));
    const later = storage.transaction(() => Promise.resolve("later"));
    firstGate.resolve();

    // Then
    await expect(failed).rejects.toBe(hookFailure);
    await first;
    await expect(later).resolves.toBe("later");
  });
});
