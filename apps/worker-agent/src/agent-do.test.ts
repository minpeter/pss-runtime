import { DurableObject } from "cloudflare:workers";
import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { describe, expect, expectTypeOf, it } from "vitest";
import { AgentDurableObject } from "./agent-do";
import {
  deliverToolOnlyTurn,
  TOOL_ONLY_DELIVERY_RECOVERY_PROMPT,
  type WorkerAgentThreadSender,
} from "./agent-do-delivery";
import { parseAgentRequest } from "./agent-do-request";
import {
  type ChannelAddress,
  channelKey,
  durableObjectChannelBinding,
  localChannelBinding,
} from "./channel";
import type { Env } from "./env";
import { SEND_MESSAGE_TOOL_NAME } from "./tools";

describe("AgentDurableObject Cloudflare contract", () => {
  it("declares the exported class as a DurableObject subclass", () => {
    expectTypeOf<InstanceType<typeof AgentDurableObject>>().toExtend<
      DurableObject<Env>
    >();
    expect(Object.getPrototypeOf(AgentDurableObject.prototype)).toBe(
      DurableObject.prototype
    );
  });
});

describe("AgentDurableObject request parsing", () => {
  it("trims valid text payloads", async () => {
    await expect(
      parseAgentRequest(
        new Request("https://agent.internal/turn", {
          body: JSON.stringify({
            channel: { id: " chat-1 ", kind: "telegram" },
            text: " hello ",
          }),
          method: "POST",
        })
      )
    ).resolves.toEqual({
      channel: { id: "chat-1", kind: "telegram" },
      text: "hello",
    });
  });

  it("rejects invalid JSON as missing text", async () => {
    await expect(
      parseAgentRequest(
        new Request("https://agent.internal/turn", {
          body: "{",
          method: "POST",
        })
      )
    ).resolves.toBeUndefined();
  });

  it("rejects non-string text payloads", async () => {
    await expect(
      parseAgentRequest(
        new Request("https://agent.internal/turn", {
          body: JSON.stringify({
            channel: { id: "chat-1", kind: "telegram" },
            text: 1,
          }),
          method: "POST",
        })
      )
    ).resolves.toBeUndefined();
  });

  it("rejects payloads without a channel id", async () => {
    await expect(
      parseAgentRequest(
        new Request("https://agent.internal/turn", {
          body: JSON.stringify({
            channel: { id: " ", kind: "telegram" },
            text: "hello",
          }),
          method: "POST",
        })
      )
    ).resolves.toBeUndefined();
  });

  it("rejects unknown channel kinds", async () => {
    await expect(
      parseAgentRequest(
        new Request("https://agent.internal/turn", {
          body: JSON.stringify({
            channel: { id: "chat-1", kind: "discord" },
            text: "hello",
          }),
          method: "POST",
        })
      )
    ).resolves.toBeUndefined();
  });
});

describe("channel runtime bindings", () => {
  it("keeps the model-facing channel key readable", () => {
    const channel: ChannelAddress = { id: "chat-1", kind: "telegram" };

    expect(channelKey(channel)).toBe("telegram:chat-1");
  });

  it("uses a default runtime thread inside channel-scoped Durable Objects", () => {
    const binding = durableObjectChannelBinding({
      id: "chat-1",
      kind: "telegram",
    });

    expect(binding.channelKey).toBe("telegram:chat-1");
    expect(binding.thread).toBe("default");
    expect(binding.threadKey).toBe("default");
  });

  it("uses a scoped runtime ThreadAddress for local multi-channel hosts", () => {
    const binding = localChannelBinding({ id: "local", kind: "tui" });

    expect(binding.channelKey).toBe("tui:local");
    expect(binding.thread).toEqual({ key: "local", scope: "channel:tui" });
    expect(binding.threadKey).toBe("scope:channel%3Atui:thread:local");
  });
});

describe("tool-only turn delivery", () => {
  it("returns delivered when the first turn sends a tool message", async () => {
    const { inputs, thread } = threadWithTurns([
      runWithEvents([sendMessageEvent()]),
    ]);

    await expect(deliverToolOnlyTurn(thread, "hello")).resolves.toEqual({
      delivered: true,
    });
    expect(inputs).toEqual(["hello"]);
  });

  it("runs one recovery turn when the first turn misses tool delivery", async () => {
    const { inputs, thread } = threadWithTurns([
      runWithEvents([{ text: "assistant-only", type: "assistant-output" }]),
      runWithEvents([sendMessageEvent()]),
    ]);

    await expect(deliverToolOnlyTurn(thread, "hello")).resolves.toEqual({
      delivered: true,
    });
    expect(inputs).toEqual(["hello", TOOL_ONLY_DELIVERY_RECOVERY_PROMPT]);
  });

  it("returns a missing-send error when recovery also misses tool delivery", async () => {
    const { inputs, thread } = threadWithTurns([
      runWithEvents([{ text: "assistant-only", type: "assistant-output" }]),
      runWithEvents([
        { text: "still assistant-only", type: "assistant-output" },
      ]),
    ]);

    await expect(deliverToolOnlyTurn(thread, "hello")).resolves.toEqual({
      delivered: false,
      error: "missing_send_message",
    });
    expect(inputs).toEqual(["hello", TOOL_ONLY_DELIVERY_RECOVERY_PROMPT]);
  });
});

function threadWithTurns(turns: readonly AgentTurn[]): {
  readonly inputs: string[];
  readonly thread: WorkerAgentThreadSender;
} {
  const inputs: string[] = [];
  let nextTurnIndex = 0;
  return {
    inputs,
    thread: {
      send: (input) => {
        inputs.push(input);
        const turn = turns[nextTurnIndex];
        nextTurnIndex += 1;
        if (!turn) {
          throw new Error("No test turn queued.");
        }
        return Promise.resolve(turn);
      },
    },
  };
}

function sendMessageEvent(): AgentEvent {
  return {
    output: {
      type: "json",
      value: {
        channel: "chat-1",
        delivered: true,
        messageId: "msg-1",
      },
    },
    toolCallId: "call-1",
    toolName: SEND_MESSAGE_TOOL_NAME,
    type: "tool-result",
  };
}

function runWithEvents(events: readonly AgentEvent[]): AgentTurn {
  return {
    events: () => eventStream(events),
  };
}

async function* eventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  yield* events;
}
