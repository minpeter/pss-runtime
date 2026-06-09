import { describe, expect, it } from "vitest";
import { wrapPokeMessage, wrapUserMessage } from "./message-tags";
import { createPokeTagsPlugin, createUserTagsPlugin } from "./message-tags-plugin";

describe("message tags", () => {
  it("wraps user messages", () => {
    expect(wrapUserMessage("hello")).toBe("<user>\nhello\n</user>");
  });

  it("wraps poke messages", () => {
    expect(wrapPokeMessage("find todos")).toBe("<poke>\nfind todos\n</poke>");
  });
});

describe("message tag plugins", () => {
  it("transforms send-source user-text with user tags", async () => {
    const plugin = createUserTagsPlugin();
    const result = await plugin.on?.({
      event: {
        meta: { source: "send" },
        text: "hello",
        type: "user-text",
      },
      history: [],
    });

    expect(result).toEqual({
      action: "transform",
      event: {
        meta: { source: "send" },
        text: "<user>\nhello\n</user>",
        type: "user-text",
      },
    });
  });

  it("transforms delegate-source user-text with poke tags", async () => {
    const plugin = createPokeTagsPlugin();
    const result = await plugin.on?.({
      event: {
        meta: { source: "delegate" },
        text: "find todos",
        type: "user-text",
      },
      history: [],
    });

    expect(result).toEqual({
      action: "transform",
      event: {
        meta: { source: "delegate" },
        text: "<poke>\nfind todos\n</poke>",
        type: "user-text",
      },
    });
  });
});