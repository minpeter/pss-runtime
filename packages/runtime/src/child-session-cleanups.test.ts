import { describe, expect, it } from "vitest";
import { ChildSessionCleanups } from "./child-session-cleanups";

describe("child session cleanups", () => {
  it("retries failed cleanups while removing successful cleanups", async () => {
    const cleanups = new ChildSessionCleanups();
    let failingCalls = 0;
    let successfulCalls = 0;

    cleanups.register("parent", () => {
      failingCalls += 1;
      if (failingCalls === 1) {
        return Promise.reject(new Error("transient cleanup failure"));
      }

      return Promise.resolve();
    });
    cleanups.register("parent", () => {
      successfulCalls += 1;
      return Promise.resolve();
    });

    await expect(cleanups.delete("parent")).rejects.toThrow(
      "transient cleanup failure"
    );
    await cleanups.delete("parent");

    expect(failingCalls).toBe(2);
    expect(successfulCalls).toBe(1);
  });
});
