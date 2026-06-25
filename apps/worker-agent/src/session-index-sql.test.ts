import { describe, expect, it } from "vitest";

import { createSessionIndexStore } from "./session-index";
import { createSqlSessionIndexRepository } from "./session-index-sql";
import { createNodeTestSqlStorage } from "./session-index-test-sql";

describe("sql session index repository", () => {
  it("persists, upserts, and round-trips records via SQLite", async () => {
    const repository = createSqlSessionIndexRepository(
      createNodeTestSqlStorage()
    );
    const store = createSessionIndexStore(repository);

    await store.upsert({
      channel: { id: "a", kind: "telegram" },
      now: 10,
      threadKey: "thread:telegram:a",
      userText: "first message about migrations",
    });
    await store.upsert({
      channel: { id: "a", kind: "telegram" },
      now: 20,
      threadKey: "thread:telegram:a",
      userText: "second message about migrations",
    });
    await store.upsert({
      channel: { id: "b", kind: "tui" },
      now: 30,
      threadKey: "thread:tui:b",
      userText: "unrelated weather chat",
    });

    const all = await repository.all();
    expect(all).toHaveLength(2);

    const telegram = all.find(
      (record) => record.conversationKey === "telegram:a"
    );
    expect(telegram?.threadKey).toBe("thread:telegram:a");
    expect(telegram?.turnCount).toBe(2);
    expect(telegram?.recentUserText).toEqual([
      "first message about migrations",
      "second message about migrations",
    ]);

    const results = await store.search("migrations");
    expect(results).toHaveLength(1);
    expect(results[0]?.conversationKey).toBe("telegram:a");

    const listed = await store.list();
    expect(listed.map((session) => session.conversationKey)).toEqual([
      "tui:b",
      "telegram:a",
    ]);
  });
});
