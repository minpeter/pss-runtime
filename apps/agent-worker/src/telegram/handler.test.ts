import {
  createCloudflareDurableObjectHost,
  drainAgentRun,
  InMemoryCloudflareDurableObjectStorage,
} from "@minpeter/pss-runtime/cloudflare";
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: generateTextMock,
  };
});

import { createChatAgent } from "../agent/factory";
import { handleTelegramMessage } from "./handler";
import { debugResetConfirmation } from "./replies";
import { sessionKeyForThread, storePrefixForThread } from "./session";

vi.mock("../agent/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/config")>();
  return {
    ...actual,
    createLanguageModel: () => ({}) as LanguageModel,
  };
});

const bindings = {
  AI_API_KEY: "test-key",
  EXA_API_KEY: "test-exa-key",
};

function createThread() {
  const posts: Array<string | { readonly markdown: string }> = [];
  return {
    thread: {
      id: "thread-1",
      addReaction: vi.fn().mockResolvedValue(undefined),
      post(message: string | { readonly markdown: string }) {
        posts.push(message);
        return Promise.resolve();
      },
      startTyping: vi.fn().mockResolvedValue(undefined),
    },
    posts,
  };
}

async function* emptyEvents() {
  await Promise.resolve();
  yield* [];
}

const testAuthor = {
  fullName: "Tester",
  userId: "user-1",
  userName: "tester",
} as const;

const testMessage = {
  author: testAuthor,
  id: "msg-1",
  text: "hello",
} as const;

describe("handleTelegramMessage", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [
        {
          content: [{ text: "DONE", type: "text" }],
          role: "assistant",
        },
      ],
    });
  });

  it("posts help when /help is sent", async () => {
    const { thread, posts } = createThread();
    await handleTelegramMessage({
      bindings,
      message: { ...testMessage, text: "/help" },
      storage: new InMemoryCloudflareDurableObjectStorage(),
      thread,
    });

    expect(posts).toEqual([{ markdown: expect.stringContaining("/help") }]);
  });

  it("clears the stored session when /debug_reset is sent", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const storePrefix = storePrefixForThread("thread-1", "user-1");
    const sessionKey = sessionKeyForThread("thread-1", "user-1");
    const host = createCloudflareDurableObjectHost({
      prefix: storePrefix,
      storage,
    });
    const agent = createChatAgent(storage, storePrefix, bindings);
    await drainAgentRun(await agent.session(sessionKey).send("hello"));
    expect(await host.store.sessions.load(sessionKey)).not.toBeNull();

    const { thread, posts } = createThread();
    await handleTelegramMessage({
      bindings,
      message: { ...testMessage, text: "/debug_reset" },
      storage,
      thread,
    });

    expect(await host.store.sessions.load(sessionKey)).toBeNull();
    expect(posts).toEqual([debugResetConfirmation()]);
  });

  it("accepts /debug_reset with a bot username suffix", async () => {
    const { thread, posts } = createThread();
    await handleTelegramMessage({
      bindings,
      message: { ...testMessage, text: "/debug_reset@pss_agent" },
      storage: new InMemoryCloudflareDurableObjectStorage(),
      thread,
    });

    expect(posts).toEqual([debugResetConfirmation()]);
  });

  it("sends plain user text to the agent for plugin-based user tagging", async () => {
    const send = vi.fn().mockResolvedValue({
      events: emptyEvents,
    });
    const factory = await import("../agent/factory");
    const createChatAgentSpy = vi
      .spyOn(factory, "createChatAgent")
      .mockReturnValue({
        session: () => ({ delete: vi.fn(), send }),
      } as unknown as ReturnType<typeof createChatAgent>);
    const events = await import("./events");
    vi.spyOn(events, "assistantTextFromEvents").mockReturnValue(undefined);

    const { thread } = createThread();
    await handleTelegramMessage({
      bindings,
      message: testMessage,
      storage: new InMemoryCloudflareDurableObjectStorage(),
      thread,
    });

    expect(send).toHaveBeenCalledWith("hello");
    createChatAgentSpy.mockRestore();
  });

  it("posts agent replies as separate bubbles split on blank lines", async () => {
    const events = await import("./events");
    vi.spyOn(events, "assistantTextFromEvents").mockReturnValue(
      "First part.\n\nSecond part."
    );
    const { thread, posts } = createThread();
    await handleTelegramMessage({
      bindings,
      message: testMessage,
      storage: new InMemoryCloudflareDurableObjectStorage(),
      thread,
    });

    expect(posts).toEqual([
      { markdown: "First part." },
      { markdown: "Second part." },
    ]);
  });

  it("posts block-tagged replies as a single bubble", async () => {
    const events = await import("./events");
    vi.spyOn(events, "assistantTextFromEvents").mockReturnValue(
      "<block>A\n\nB</block>"
    );
    const { thread, posts } = createThread();
    await handleTelegramMessage({
      bindings,
      message: testMessage,
      storage: new InMemoryCloudflareDurableObjectStorage(),
      thread,
    });

    expect(posts).toEqual([{ markdown: "A\n\nB" }]);
  });

  it("sends nothing when the agent produces no assistant text", async () => {
    const events = await import("./events");
    vi.spyOn(events, "assistantTextFromEvents").mockReturnValue(undefined);
    const { thread, posts } = createThread();
    await handleTelegramMessage({
      bindings,
      message: testMessage,
      storage: new InMemoryCloudflareDurableObjectStorage(),
      thread,
    });

    expect(posts).toEqual([]);
  });
});
