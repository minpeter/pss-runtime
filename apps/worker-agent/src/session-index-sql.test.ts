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

  it("defaults legacy rows without session_scope_key to their conversation key", async () => {
    const sql = createNodeTestSqlStorage();
    sql.exec(
      `CREATE TABLE pss_worker_session_index (
        conversation_key TEXT PRIMARY KEY,
        channel_kind TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_key TEXT,
        last_seen_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL,
        recent_user_text TEXT NOT NULL,
        recent_assistant_text TEXT NOT NULL
      )`
    );
    sql.exec(
      `INSERT INTO pss_worker_session_index (
        conversation_key,
        channel_kind,
        channel_id,
        thread_key,
        last_seen_at,
        turn_count,
        recent_user_text,
        recent_assistant_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "telegram:legacy",
      "telegram",
      "legacy",
      "thread:telegram:legacy",
      10,
      1,
      JSON.stringify(["legacy text"]),
      JSON.stringify([])
    );
    const repository = createSqlSessionIndexRepository(sql);

    const [record] = await repository.all();

    expect(record?.conversationKey).toBe("telegram:legacy");
    expect(record?.sessionScopeKey).toBe("telegram:legacy");
  });
});
