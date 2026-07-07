import { describe, expect, it } from "vitest";
import type { ExecutionStore } from "../../execution";
import { collectThreadEvents } from "./fixtures";

export interface ThreadEventLogContractOptions {
  readonly createStore: () => ExecutionStore;
}

export function describeThreadEventLogContract({
  createStore,
}: ThreadEventLogContractOptions): void {
  describe("thread event log", () => {
    it("replays thread events with limit and cursor pagination", async () => {
      const store = createStore();
      const threadEvents = store.threadEvents;
      if (!threadEvents) {
        throw new Error("expected thread event log");
      }

      await threadEvents.append("thread-1", { type: "turn-start" });
      const cursor = await threadEvents.append("thread-1", {
        text: "DONE",
        type: "assistant-output",
      });
      await threadEvents.append("thread-1", { type: "turn-end" });

      const firstPage = await collectThreadEvents(
        threadEvents.read("thread-1", { limit: 2 })
      );
      const secondPage = await collectThreadEvents(
        threadEvents.read("thread-1", { after: cursor })
      );

      expect(firstPage).toEqual([
        {
          cursor: { offset: 1 },
          event: { type: "turn-start" },
          threadKey: "thread-1",
        },
        {
          cursor: { offset: 2 },
          event: { text: "DONE", type: "assistant-output" },
          threadKey: "thread-1",
        },
      ]);
      expect(secondPage).toEqual([
        {
          cursor: { offset: 3 },
          event: { type: "turn-end" },
          threadKey: "thread-1",
        },
      ]);
    });

    it("rejects invalid thread event replay limits", async () => {
      const store = createStore();
      const threadEvents = store.threadEvents;
      if (!threadEvents) {
        throw new Error("expected thread event log");
      }

      await threadEvents.append("thread-1", { type: "turn-start" });

      await expect(
        collectThreadEvents(threadEvents.read("thread-1", { limit: -1 }))
      ).rejects.toThrow(RangeError);
    });
  });
}
