import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "./test-support";

class RejectingDeleteStore extends SpyStore {
  override delete(_key: string): Promise<void> {
    return Promise.reject(new Error("delete failed"));
  }
}

describe("Agent thread delete failure", () => {
  it("hard-stops the thread handle when persistence deletion fails", async () => {
    const store = new RejectingDeleteStore();
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("delete-failure");

    await collect(await thread.send("before"));

    await expect(thread.delete()).rejects.toThrow("delete failed");

    await expect(thread.send("after")).rejects.toThrow("Thread killed");
    expect(JSON.stringify(store.threads.get("delete-failure"))).not.toContain(
      "after"
    );
  });
});
