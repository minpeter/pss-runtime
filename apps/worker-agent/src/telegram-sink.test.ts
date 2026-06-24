import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTelegramMessageSink,
  TelegramMessageSinkError,
} from "./telegram-sink";

interface TelegramAdapterOptions {
  readonly botToken?: unknown;
  readonly mode?: unknown;
  readonly userName?: unknown;
}

const telegramMock = vi.hoisted(
  (): {
    readonly adapters: TelegramAdapterOptions[];
    readonly sent: string[];
  } => ({
    adapters: [],
    sent: [],
  })
);

vi.mock("@chat-adapter/telegram", () => ({
  createTelegramAdapter: (options: TelegramAdapterOptions) => {
    telegramMock.adapters.push(options);
    return {
      postChannelMessage: (channelId: string, text: string) => {
        telegramMock.sent.push(`${channelId}:${text}`);
        return Promise.resolve({ id: "tg-msg-1", threadId: channelId });
      },
    };
  },
}));

describe("Telegram channel sink", () => {
  beforeEach(() => {
    telegramMock.adapters.length = 0;
    telegramMock.sent.length = 0;
  });

  it("posts telegram channel messages through the Telegram adapter", async () => {
    const sink = createTelegramMessageSink({
      botToken: "token",
      userName: "bot",
    });

    await expect(
      sink.send({ id: "chat-1", kind: "telegram" }, "hello")
    ).resolves.toEqual({
      messageId: "tg-msg-1",
      threadId: "chat-1",
    });
    expect(telegramMock.adapters).toEqual([
      { botToken: "token", mode: "webhook", userName: "bot" },
    ]);
    expect(telegramMock.sent).toEqual(["chat-1:hello"]);
  });

  it("rejects non-telegram channels", async () => {
    const sink = createTelegramMessageSink({ botToken: "token" });

    await expect(
      sink.send({ id: "local", kind: "tui" }, "hello")
    ).rejects.toThrow(TelegramMessageSinkError);
    expect(telegramMock.sent).toEqual([]);
  });
});
