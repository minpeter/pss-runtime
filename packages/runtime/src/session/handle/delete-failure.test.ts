import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
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

describe("Agent session delete failure", () => {
  it("hard-stops the session handle when persistence deletion fails", async () => {
    const store = new RejectingDeleteStore();
    const agent = new Agent({
      host: { kind: "session", sessionStore: store },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const session = agent.thread("delete-failure");

    await collect(await session.send("before"));

    await expect(session.delete()).rejects.toThrow("delete failed");

    await expect(session.send("after")).rejects.toThrow("Session killed");
    expect(JSON.stringify(store.sessions.get("delete-failure"))).not.toContain(
      "after"
    );
  });
});
