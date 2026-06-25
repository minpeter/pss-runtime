import { describe, expect, it } from "vitest";

import {
  createMemorySessionIndexRepository,
  createSessionIndexStore,
  MAX_RECENT_USER_TEXT,
  mergeSessionRecord,
  type SessionIndexRecord,
  summarizeSessionRecord,
} from "./session-index";
import { scoreSessionRecord } from "./session-index-search";

describe("mergeSessionRecord", () => {
  it("creates a new record from the first turn", () => {
    const record = mergeSessionRecord(
      undefined,
      {
        assistantText: ["hi there"],
        channel: { id: "123", kind: "telegram" },
        now: 1000,
        threadKey: "thread:telegram:123",
        userText: " hello ",
      },
      "telegram:123"
    );

    expect(record).toEqual({
      channelId: "123",
      channelKind: "telegram",
      conversationKey: "telegram:123",
      lastSeenAt: 1000,
      recentAssistantText: ["hi there"],
      recentUserText: ["hello"],
      threadKey: "thread:telegram:123",
      turnCount: 1,
    });
  });

  it("appends turns and caps the recent user text window", () => {
    let record: SessionIndexRecord | undefined;
    for (let index = 0; index < MAX_RECENT_USER_TEXT + 3; index += 1) {
      record = mergeSessionRecord(
        record,
        {
          channel: { id: "123", kind: "telegram" },
          now: index,
          threadKey: "thread:telegram:123",
          userText: `message-${index}`,
        },
        "telegram:123"
      );
    }

    expect(record?.turnCount).toBe(MAX_RECENT_USER_TEXT + 3);
    expect(record?.recentUserText).toHaveLength(MAX_RECENT_USER_TEXT);
    expect(record?.recentUserText.at(-1)).toBe(
      `message-${MAX_RECENT_USER_TEXT + 2}`
    );
    expect(record?.lastSeenAt).toBe(MAX_RECENT_USER_TEXT + 2);
  });

  it("ignores blank user and assistant text without losing the turn count", () => {
    const record = mergeSessionRecord(
      undefined,
      {
        assistantText: ["   "],
        channel: { id: "local", kind: "tui" },
        now: 5,
        threadKey: "thread:tui:local",
        userText: "   ",
      },
      "tui:local"
    );

    expect(record.recentUserText).toEqual([]);
    expect(record.recentAssistantText).toEqual([]);
    expect(record.turnCount).toBe(1);
  });
});

describe("scoreSessionRecord", () => {
  const record: SessionIndexRecord = {
    channelId: "123",
    channelKind: "telegram",
    conversationKey: "telegram:123",
    lastSeenAt: 1,
    recentAssistantText: ["the answer is forty two"],
    recentUserText: ["tell me about quantum computing"],
    threadKey: "thread:telegram:123",
    turnCount: 1,
  };

  it("scores user-text matches higher than assistant-text matches", () => {
    const userScore = scoreSessionRecord(record, ["quantum"], "quantum");
    const assistantScore = scoreSessionRecord(record, ["forty"], "forty");
    expect(userScore).toBeGreaterThan(assistantScore);
  });

  it("returns zero for an empty query", () => {
    expect(scoreSessionRecord(record, [], "")).toBe(0);
  });
});

describe("summarizeSessionRecord", () => {
  it("prefers the latest user text as the snippet", () => {
    const summary = summarizeSessionRecord({
      channelId: "123",
      channelKind: "telegram",
      conversationKey: "telegram:123",
      lastSeenAt: 1,
      recentAssistantText: ["assistant"],
      recentUserText: ["first", "latest user line"],
      threadKey: "thread:telegram:123",
      turnCount: 2,
    });

    expect(summary.snippet).toBe("latest user line");
    expect(summary.channel).toEqual({ id: "123", kind: "telegram" });
    expect(summary.threadKey).toBe("thread:telegram:123");
  });
});

describe("session index store", () => {
  it("lists sessions by recency and excludes the current conversation", async () => {
    const store = createSessionIndexStore(createMemorySessionIndexRepository());
    await store.upsert({
      channel: { id: "a", kind: "telegram" },
      now: 10,
      threadKey: "thread:telegram:a",
      userText: "older",
    });
    await store.upsert({
      channel: { id: "b", kind: "telegram" },
      now: 20,
      threadKey: "thread:telegram:b",
      userText: "newer",
    });

    const sessions = await store.list({ excludeKey: "telegram:b" });
    expect(sessions.map((session) => session.conversationKey)).toEqual([
      "telegram:a",
    ]);
  });

  it("searches across conversations and sorts by score", async () => {
    const store = createSessionIndexStore(createMemorySessionIndexRepository());
    await store.upsert({
      channel: { id: "a", kind: "telegram" },
      now: 10,
      threadKey: "thread:telegram:a",
      userText: "let us discuss the database migration plan",
    });
    await store.upsert({
      channel: { id: "b", kind: "tui" },
      now: 20,
      threadKey: "thread:tui:b",
      userText: "weather is nice today",
    });

    const results = await store.search("database migration");
    expect(results).toHaveLength(1);
    expect(results[0]?.conversationKey).toBe("telegram:a");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("returns nothing for a blank query", async () => {
    const store = createSessionIndexStore(createMemorySessionIndexRepository());
    await store.upsert({
      channel: { id: "a", kind: "telegram" },
      threadKey: "thread:telegram:a",
      userText: "anything",
    });

    expect(await store.search("   ")).toEqual([]);
  });
});
