import { describe, expect, it } from "vitest";
import type { ChannelMessageSink } from "./channel";
import {
  createSendMessageTool,
  SendMessageToolConfigError,
  SendMessageToolInputError,
} from "./tools";

describe("send_message tool", () => {
  it("sends trimmed text to the current channel", async () => {
    const sent: string[] = [];
    const sink: ChannelMessageSink = {
      send: (channel, text) => {
        sent.push(`${channel.kind}:${channel.id}:${text}`);
        return Promise.resolve({
          channel: `${channel.kind}:${channel.id}`,
          messageId: "msg-1",
        });
      },
    };
    const tool = createSendMessageTool({
      channel: () => ({ id: "chat-1", kind: "telegram" }),
      sink,
    });

    await expect(
      tool.execute?.(
        { text: " hello " },
        {
          abortSignal: new AbortController().signal,
          context: undefined,
          messages: [],
          toolCallId: "call-1",
        }
      )
    ).resolves.toEqual({
      channel: "telegram:chat-1",
      delivered: true,
      messageId: "msg-1",
    });
    expect(sent).toEqual(["telegram:chat-1:hello"]);
  });

  it("rejects the removed final flag as an unknown field", async () => {
    const tool = createSendMessageTool({
      channel: () => ({ id: "chat-1", kind: "telegram" }),
      sink: {
        send: () => {
          throw new Error("send should not run for invalid input");
        },
      },
    });

    await expect(
      tool.execute?.(
        { final: true, text: "hello" },
        {
          abortSignal: new AbortController().signal,
          context: undefined,
          messages: [],
          toolCallId: "call-1",
        }
      )
    ).rejects.toThrow();
  });

  it("rejects blank text before sending", async () => {
    const sent: string[] = [];
    const tool = createSendMessageTool({
      channel: () => ({ id: "chat-1", kind: "telegram" }),
      sink: {
        send: (channel, text) => {
          sent.push(`${channel.kind}:${channel.id}:${text}`);
          return Promise.resolve({
            channel: `${channel.kind}:${channel.id}`,
            messageId: "msg-1",
          });
        },
      },
    });

    await expect(
      tool.execute?.(
        { text: " " },
        {
          abortSignal: new AbortController().signal,
          context: undefined,
          messages: [],
          toolCallId: "call-1",
        }
      )
    ).rejects.toThrow(SendMessageToolInputError);
    expect(sent).toEqual([]);
  });

  it("rejects missing channel id before sending", async () => {
    const sent: string[] = [];
    const tool = createSendMessageTool({
      channel: () => undefined,
      sink: {
        send: (channel, text) => {
          sent.push(`${channel.kind}:${channel.id}:${text}`);
          return Promise.resolve({
            channel: `${channel.kind}:${channel.id}`,
            messageId: "msg-1",
          });
        },
      },
    });

    await expect(
      tool.execute?.(
        { text: "hello" },
        {
          abortSignal: new AbortController().signal,
          context: undefined,
          messages: [],
          toolCallId: "call-1",
        }
      )
    ).rejects.toThrow(SendMessageToolConfigError);
    expect(sent).toEqual([]);
  });
});
