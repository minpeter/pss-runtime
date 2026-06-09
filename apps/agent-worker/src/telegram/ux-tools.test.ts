import { describe, expect, it, vi } from "vitest";
import type { TelegramThreadLike } from "./handler";
import { createTelegramUxTools } from "./ux-tools";

function toolExecutionOptions(toolCallId: string) {
  return {
    context: {},
    messages: [],
    toolCallId,
  };
}

function createMockThread(): TelegramThreadLike & {
  readonly addReaction: ReturnType<typeof vi.fn>;
  readonly post: ReturnType<typeof vi.fn>;
} {
  return {
    id: "telegram:chat-1:chat-1",
    addReaction: vi.fn().mockResolvedValue(undefined),
    post: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createTelegramUxTools", () => {
  it("reactto_message adds a reaction on the current thread", async () => {
    const thread = createMockThread();
    const tools = createTelegramUxTools({
      messageId: "msg-1",
      thread,
    });
    const reactTool = tools.reactto_message;
    if (!(reactTool && "execute" in reactTool && reactTool.execute)) {
      throw new Error("expected reactto_message tool");
    }

    await reactTool.execute(
      { emoji: "👍" },
      toolExecutionOptions("call-react-test")
    );

    expect(thread.addReaction).toHaveBeenCalledWith("👍");
  });

  it("display_draft posts the full text as one message", async () => {
    const thread = createMockThread();
    const tools = createTelegramUxTools({
      messageId: "msg-1",
      thread,
    });
    const draftTool = tools.display_draft;
    if (!(draftTool && "execute" in draftTool && draftTool.execute)) {
      throw new Error("expected display_draft tool");
    }

    const text = "Line one\n\nLine two";
    await draftTool.execute({ text }, toolExecutionOptions("call-draft-test"));

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(thread.post).toHaveBeenCalledWith({ markdown: text });
  });
});
