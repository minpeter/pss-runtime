import { describe, expect, it } from "vitest";

import {
  createMemorySessionIndexRepository,
  createSessionIndexStore,
} from "./session-index";
import {
  createSessionTools,
  LIST_SESSIONS_TOOL_NAME,
  type ListSessionsToolResult,
  READ_SESSION_TOOL_NAME,
  type ReadSessionToolResult,
  SEARCH_SESSIONS_TOOL_NAME,
  type SearchSessionsToolResult,
} from "./session-tools";

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    context: undefined,
    messages: [] as [],
    toolCallId: "call-1",
  };
}

async function seededReader() {
  const store = createSessionIndexStore(createMemorySessionIndexRepository());
  await store.upsert({
    channel: { id: "a", kind: "telegram" },
    now: 10,
    threadKey: "thread:telegram:a",
    userText: "we planned the database migration",
  });
  await store.upsert({
    channel: { id: "current", kind: "tui" },
    now: 20,
    threadKey: "thread:tui:current",
    userText: "this is the active conversation",
  });
  return store;
}

describe("session search tools", () => {
  it("lists recent sessions excluding the current conversation", async () => {
    const reader = await seededReader();
    const tools = createSessionTools({
      currentConversationKey: () => "tui:current",
      reader,
    });

    const result = (await tools[LIST_SESSIONS_TOOL_NAME]?.execute?.(
      {},
      toolContext()
    )) as ListSessionsToolResult;

    expect(result.sessions.map((session) => session.channel)).toEqual([
      "telegram:a",
    ]);
    expect(result.sessions[0]).not.toHaveProperty("conversationKey");
    expect(result.sessions[0]).not.toHaveProperty("threadKey");
    expect(result.sessions[0]?.lastSeenAt).toBe("1970-01-01T00:00:00.010Z");
  });

  it("searches sessions and returns compact scored entries", async () => {
    const reader = await seededReader();
    const tools = createSessionTools({
      currentConversationKey: () => undefined,
      reader,
    });

    const result = (await tools[SEARCH_SESSIONS_TOOL_NAME]?.execute?.(
      { query: "database migration" },
      toolContext()
    )) as SearchSessionsToolResult;

    expect(result.query).toBe("database migration");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.channel).toBe("telegram:a");
    expect(result.sessions[0]).not.toHaveProperty("conversationKey");
    expect(result.sessions[0]).not.toHaveProperty("threadKey");
    expect(result.sessions[0]?.score).toBeGreaterThan(0);
  });

  it("reads a selected session transcript by conversation key", async () => {
    const reader = await seededReader();
    const tools = createSessionTools({
      currentConversationKey: () => "tui:current",
      reader,
      transcriptReader: {
        read: (conversationKey) =>
          Promise.resolve({
            conversationKey,
            hasMore: false,
            messageCount: 2,
            messages: [
              { index: 0, role: "user", text: "old question" },
              { index: 1, role: "assistant", text: "old answer" },
            ],
          }),
      },
    });

    const result = (await tools[READ_SESSION_TOOL_NAME]?.execute?.(
      { channel: "telegram:a" },
      toolContext()
    )) as ReadSessionToolResult;

    expect(result).toEqual({
      channel: "telegram:a",
      found: true,
      hasMore: false,
      messageCount: 2,
      messages: [
        { index: 0, role: "user", text: "old question" },
        { index: 1, role: "assistant", text: "old answer" },
      ],
    });
  });

  it("keeps list, search, and read_session inside the current requester scope", async () => {
    const store = createSessionIndexStore(createMemorySessionIndexRepository());
    await store.upsert({
      channel: { id: "own", kind: "telegram" },
      now: 10,
      sessionScopeKey: "requester:one",
      threadKey: "thread:telegram:own",
      userText: "Project Zephyr launches Friday",
    });
    await store.upsert({
      channel: { id: "other", kind: "telegram" },
      now: 20,
      sessionScopeKey: "requester:two",
      threadKey: "thread:telegram:other",
      userText: "Project Zephyr launches Tuesday",
    });
    const transcriptReads: string[] = [];
    const tools = createSessionTools({
      currentConversationKey: () => "tui:current",
      currentSessionScopeKey: () => "requester:one",
      reader: store,
      transcriptReader: {
        read: (conversationKey) => {
          transcriptReads.push(conversationKey);
          return Promise.resolve({
            conversationKey,
            hasMore: false,
            messageCount: 1,
            messages: [{ index: 0, role: "user", text: "old question" }],
          });
        },
      },
    });

    const list = (await tools[LIST_SESSIONS_TOOL_NAME]?.execute?.(
      {},
      toolContext()
    )) as ListSessionsToolResult;
    const search = (await tools[SEARCH_SESSIONS_TOOL_NAME]?.execute?.(
      { query: "Project Zephyr" },
      toolContext()
    )) as SearchSessionsToolResult;
    const denied = (await tools[READ_SESSION_TOOL_NAME]?.execute?.(
      { channel: "telegram:other" },
      toolContext()
    )) as ReadSessionToolResult;

    expect(list.sessions.map((session) => session.channel)).toEqual([
      "telegram:own",
    ]);
    expect(search.sessions.map((session) => session.channel)).toEqual([
      "telegram:own",
    ]);
    expect(denied).toEqual({ channel: "telegram:other", found: false });
    expect(transcriptReads).toEqual([]);
  });

  it("does not scope production recall to the current conversation when no requester scope exists", async () => {
    const store = createSessionIndexStore(createMemorySessionIndexRepository());
    await store.upsert({
      channel: { id: "current", kind: "telegram" },
      now: 10,
      threadKey: "thread:telegram:current",
      userText: "active Project Orion thread",
    });
    await store.upsert({
      channel: { id: "other", kind: "telegram" },
      now: 20,
      threadKey: "thread:telegram:other",
      userText: "Project Orion status moved to Friday",
    });
    const tools = createSessionTools({
      currentConversationKey: () => "telegram:current",
      reader: store,
      transcriptReader: {
        read: (conversationKey) =>
          Promise.resolve({
            conversationKey,
            hasMore: false,
            messageCount: 1,
            messages: [{ index: 0, role: "user", text: "old question" }],
          }),
      },
    });

    const list = (await tools[LIST_SESSIONS_TOOL_NAME]?.execute?.(
      {},
      toolContext()
    )) as ListSessionsToolResult;
    const search = (await tools[SEARCH_SESSIONS_TOOL_NAME]?.execute?.(
      { query: "Project Orion" },
      toolContext()
    )) as SearchSessionsToolResult;
    const read = (await tools[READ_SESSION_TOOL_NAME]?.execute?.(
      { channel: "telegram:other" },
      toolContext()
    )) as ReadSessionToolResult;

    expect(list.sessions.map((session) => session.channel)).toEqual([
      "telegram:other",
    ]);
    expect(search.sessions.map((session) => session.channel)).toEqual([
      "telegram:other",
    ]);
    expect(read.found).toBe(true);
  });

  it("returns a not-found result when a selected session has no readable transcript", async () => {
    const reader = await seededReader();
    const tools = createSessionTools({
      currentConversationKey: () => undefined,
      reader,
      transcriptReader: { read: () => Promise.resolve(undefined) },
    });

    const result = (await tools[READ_SESSION_TOOL_NAME]?.execute?.(
      { channel: "telegram:missing" },
      toolContext()
    )) as ReadSessionToolResult;

    expect(result).toEqual({
      channel: "telegram:missing",
      found: false,
    });
  });

  it("rejects legacy conversationKey input when reading a session", async () => {
    const reader = await seededReader();
    const tools = createSessionTools({
      currentConversationKey: () => undefined,
      reader,
      transcriptReader: { read: () => Promise.resolve(undefined) },
    });

    await expect(
      tools[READ_SESSION_TOOL_NAME]?.execute?.(
        { conversationKey: "telegram:a" },
        toolContext()
      )
    ).rejects.toThrow();
  });

  it("rejects an empty search query", async () => {
    const reader = await seededReader();
    const tools = createSessionTools({
      currentConversationKey: () => undefined,
      reader,
    });

    await expect(
      tools[SEARCH_SESSIONS_TOOL_NAME]?.execute?.({ query: "" }, toolContext())
    ).rejects.toThrow();
  });

  it("rejects unknown input fields", async () => {
    const reader = await seededReader();
    const tools = createSessionTools({
      currentConversationKey: () => undefined,
      reader,
    });

    await expect(
      tools[LIST_SESSIONS_TOOL_NAME]?.execute?.(
        { unexpected: true } as unknown as { limit?: number },
        toolContext()
      )
    ).rejects.toThrow();
  });
});
