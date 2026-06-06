import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import { assistantMessage } from "../test-fixtures";
import { collect, SpyStore } from "./session.test-support";

class RejectingDeleteStore extends SpyStore {
  override delete(_key: string): Promise<void> {
    return Promise.reject(new Error("delete failed"));
  }
}

describe("Agent session delete failure", () => {
  it("keeps the session handle usable when persistence deletion fails", async () => {
    const store = new RejectingDeleteStore();
    const agent = new Agent({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
      sessions: { store },
    });
    const session = agent.session("delete-failure");

    await collect(await session.send("before"));

    await expect(session.delete()).rejects.toThrow("delete failed");

    await collect(await session.send("after"));
    expect(JSON.stringify(store.sessions.get("delete-failure"))).toContain(
      "after"
    );
  });
});
