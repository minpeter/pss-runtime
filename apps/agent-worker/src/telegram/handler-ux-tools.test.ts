import { InMemoryCloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import type { LanguageModel, ToolSet } from "ai";
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

vi.mock("../agent/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/config")>();
  return {
    ...actual,
    createLanguageModel: () => ({}) as LanguageModel,
  };
});

import { handleTelegramMessage } from "./handler";

const bindings = {
  AI_API_KEY: "test-key",
  EXA_API_KEY: "test-exa-key",
};

function lastGenerateTextTools(): ToolSet {
  const call = generateTextMock.mock.calls.at(-1)?.[0] as
    | { tools?: ToolSet }
    | undefined;
  return call?.tools ?? {};
}

describe("handleTelegramMessage UX tools", () => {
  beforeEach(async () => {
    generateTextMock.mockReset();
    const events = await import("./events");
    vi.spyOn(events, "assistantTextFromEvents").mockReturnValue(undefined);
  });

  it("executes reactto_message against the inbound thread", async () => {
    const addReaction = vi.fn().mockResolvedValue(undefined);
    const posts: Array<string | { readonly markdown: string }> = [];
    generateTextMock.mockImplementation(async (options) => {
      const reactTool = options.tools?.reactto_message;
      if (
        reactTool &&
        "execute" in reactTool &&
        typeof reactTool.execute === "function"
      ) {
        await reactTool.execute(
          { emoji: "👍" },
          { toolCallId: "call-react-test" }
        );
      }
      return {
        responseMessages: [
          {
            content: [{ text: "", type: "text" }],
            role: "assistant",
          },
        ],
      };
    });

    await handleTelegramMessage({
      bindings,
      message: {
        author: {
          fullName: "Tester",
          userId: "user-1",
          userName: "tester",
        },
        id: "msg-42",
        text: "hello",
      },
      storage: new InMemoryCloudflareDurableObjectStorage(),
      thread: {
        id: "thread-1",
        addReaction,
        post(message) {
          posts.push(message);
          return Promise.resolve();
        },
        startTyping: vi.fn().mockResolvedValue(undefined),
      },
    });

    expect(Object.keys(lastGenerateTextTools()).sort()).toContain(
      "reactto_message"
    );
    expect(addReaction).toHaveBeenCalledWith("👍");
    expect(posts).toEqual([]);
  });

  it("executes display_draft against the inbound thread", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    generateTextMock.mockImplementation(async (options) => {
      const draftTool = options.tools?.display_draft;
      if (
        draftTool &&
        "execute" in draftTool &&
        typeof draftTool.execute === "function"
      ) {
        await draftTool.execute(
          { text: "Draft line one\n\nDraft line two" },
          { toolCallId: "call-draft-test" }
        );
      }
      return {
        responseMessages: [
          {
            content: [{ text: "", type: "text" }],
            role: "assistant",
          },
        ],
      };
    });

    await handleTelegramMessage({
      bindings,
      message: {
        author: {
          fullName: "Tester",
          userId: "user-1",
          userName: "tester",
        },
        id: "msg-42",
        text: "hello",
      },
      storage: new InMemoryCloudflareDurableObjectStorage(),
      thread: {
        id: "thread-1",
        addReaction: async () => undefined,
        post,
        startTyping: async () => undefined,
      },
    });

    expect(post).toHaveBeenCalledWith({
      markdown: "Draft line one\n\nDraft line two",
    });
  });
});
