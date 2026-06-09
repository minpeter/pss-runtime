import { describe, expect, it, vi } from "vitest";

import { collectTurnText, replyToThread } from "./telegram";

const resolved = Promise.resolve();

const env = {
  ENVIRONMENT: "development",
} as const;

describe("telegram conversation handling", () => {
  it("combines queued skipped text with the latest message", () => {
    expect(
      collectTurnText(
        { text: "latest" },
        { skipped: [{ text: "first" }, { text: "second" }] }
      )
    ).toBe("first\nsecond\nlatest");
  });

  it("subscribes mention threads and posts development notice before replies", async () => {
    const posts: string[] = [];
    const subscribe = vi.fn<() => Promise<void>>(() => resolved);

    await replyToThread({
      env,
      fetchReply: (_env, channelId, text) =>
        Promise.resolve(`${channelId}:${text}`),
      message: { text: "hello" },
      subscribe: true,
      thread: {
        channelId: "channel-1",
        post: (text: string) => {
          posts.push(text);
          return resolved;
        },
        subscribe,
      },
    });

    expect(subscribe).toHaveBeenCalledOnce();
    expect(posts).toEqual(["🧪 DEVELOPMENT ENVIRONMENT", "channel-1:hello"]);
  });

  it("does not leak internal failures to the chat thread", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const posts: string[] = [];

    await replyToThread({
      env,
      fetchReply: async () => {
        await resolved;
        throw new Error("internal secret failure");
      },
      message: { text: "hello" },
      thread: {
        channelId: "channel-1",
        post: (text: string) => {
          posts.push(text);
          return resolved;
        },
        subscribe: () => resolved,
      },
    });

    expect(posts).toEqual([
      "🧪 DEVELOPMENT ENVIRONMENT",
      "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
    ]);
    expect(errorLog).toHaveBeenCalledWith("telegram handler failed", "Error");
  });
});
