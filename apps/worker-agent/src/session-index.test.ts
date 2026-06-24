import { describe, expect, it } from "vitest";

import {
  createMemorySessionIndexRepository,
  createSessionIndexStore,
  MAX_RECENT_USER_TEXT,
  mergeSessionRecord,
  type SessionIndexRecord,
  scoreSessionRecord,
  summarizeSessionRecord,
} from "./session-index";

describe("mergeSessionRecord", () => {
  it("creates a new record from the first turn", () => {
    const record = mergeSessionRecord(
      undefined,
      {
        assistantText: ["hi there"],
        channel: { id: "123", kind: "telegram" },
        now: 1000,
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
      turnCount: 2,
    });

    expect(summary.snippet).toBe("latest user line");
    expect(summary.channel).toEqual({ id: "123", kind: "telegram" });
  });
});

describe("session index store", () => {
  it("lists sessions by recency and excludes the current conversation", async () => {
    const store = createSessionIndexStore(createMemorySessionIndexRepository());
    await store.upsert({
      channel: { id: "a", kind: "telegram" },
      now: 10,
      userText: "older",
    });
    await store.upsert({
      channel: { id: "b", kind: "telegram" },
      now: 20,
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
      userText: "let us discuss the database migration plan",
    });
    await store.upsert({
      channel: { id: "b", kind: "tui" },
      now: 20,
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
      userText: "anything",
    });

    expect(await store.search("   ")).toEqual([]);
  });
});
