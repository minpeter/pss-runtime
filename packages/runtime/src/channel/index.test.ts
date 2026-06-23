import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentEvent, AgentInput, ThreadKey } from "../index";
import { Agent } from "../index";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import {
  type ChannelAssistantDelivery,
  type ChannelInboundMessage,
  projectChannelAssistantDelivery,
} from "./index";

interface TestInboundMessage {
  readonly messageId: string;
  readonly roomId: string;
  readonly text: string;
  readonly userId: string;
}

interface TestChannelMetadata {
  readonly channel: "test";
  readonly messageId: string;
}

describe("runtime channel adapter contract", () => {
  it("lets adapters resolve channel input and deliver assistant output from turn events", async () => {
    const inboundMessage = {
      messageId: "msg-1",
      roomId: "room-7",
      text: "hello from a channel",
      userId: "user-9",
    } satisfies TestInboundMessage;
    const normalizeChatMessage = (
      message: TestInboundMessage
    ): ChannelInboundMessage => ({
      input: message.text,
      threadKey: { key: message.userId, scope: message.roomId },
    });
    const delivered: Array<
      ChannelAssistantDelivery & { readonly metadata: TestChannelMetadata }
    > = [];

    expectTypeOf<ChannelInboundMessage["input"]>().toEqualTypeOf<AgentInput>();
    expectTypeOf<
      ChannelInboundMessage["threadKey"]
    >().toEqualTypeOf<ThreadKey>();

    const agent = new Agent({
      model: createMockLanguageModelV4([
        mockLanguageModelV4Text("channel reply"),
      ]),
    });
    const inbound = normalizeChatMessage(inboundMessage);
    const turn = await agent.thread(inbound.threadKey).send(inbound.input);

    for await (const event of turn.events()) {
      const delivery = projectChannelAssistantDelivery(event);
      if (delivery !== undefined) {
        delivered.push({
          ...delivery,
          metadata: { channel: "test", messageId: inboundMessage.messageId },
        });
      }
    }

    expect(delivered).toEqual([
      {
        metadata: { channel: "test", messageId: "msg-1" },
        text: "channel reply",
        type: "assistant-text",
      },
    ]);
  });

  it("projects only non-empty assistant output into channel deliveries", () => {
    const ignoredEvents = [
      { type: "turn-start" },
      { type: "step-start" },
      { text: "thinking", type: "assistant-reasoning" },
      { text: "user said hi", type: "user-input" },
      {
        input: { text: "runtime says continue", type: "user-input" },
        placement: "turn-start",
        type: "runtime-input",
      },
      {
        input: { city: "Seoul" },
        toolCallId: "call-1",
        toolName: "weather",
        type: "tool-call",
      },
      {
        output: { ok: true },
        toolCallId: "call-1",
        toolName: "weather",
        type: "tool-result",
      },
      { type: "step-end" },
      { message: "failed", type: "turn-error" },
      { type: "turn-abort" },
      { type: "turn-end" },
      { text: "   ", type: "assistant-output" },
    ] satisfies readonly AgentEvent[];

    expect(ignoredEvents.map(projectChannelAssistantDelivery)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expectTypeOf<
      Parameters<typeof projectChannelAssistantDelivery>[0]
    >().toEqualTypeOf<AgentEvent>();
    expectTypeOf<
      ReturnType<typeof projectChannelAssistantDelivery>
    >().toEqualTypeOf<ChannelAssistantDelivery | undefined>();
    expect(
      projectChannelAssistantDelivery({
        text: " visible reply ",
        type: "assistant-output",
      })
    ).toEqual({ text: " visible reply ", type: "assistant-text" });
  });
});
