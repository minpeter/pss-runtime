import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import { TOOL_ONLY_DELIVERY_RECOVERY_PROMPT } from "./agent-do-delivery";
import {
  createTurnSession,
  type TurnSessionThread,
} from "./agent-do-turn-session";

describe("createTurnSession", () => {
  it("sends when idle and steers while a turn is active", async () => {
    const sends: unknown[] = [];
    const steers: unknown[] = [];
    let releaseSend: (() => void) | undefined;

    const thread: TurnSessionThread = {
      send: (input) => {
        sends.push(input);
        return new Promise<AgentTurn>((resolve) => {
          releaseSend = () => {
            resolve(runWithEvents([sendMessageEvent()]));
          };
        });
      },
      steer: (input) => {
        steers.push(input);
        return Promise.resolve(runWithEvents([]));
      },
    };

    const session = createTurnSession(thread);
    const first = session.deliver("hello");
    // Let admit start the send and mark active.
    await Promise.resolve();
    await Promise.resolve();
    expect(session.isActive()).toBe(true);
    expect(sends).toEqual(["hello"]);

    const second = await session.deliver("mid-turn correction");
    expect(second).toEqual({ delivered: true, mode: "steer" });
    expect(steers).toEqual(["mid-turn correction"]);
    expect(sends).toEqual(["hello"]);

    releaseSend?.();
    await expect(first).resolves.toEqual({ delivered: true, mode: "send" });
    expect(session.isActive()).toBe(false);
  });

  it("starts a new send after the previous turn finishes", async () => {
    const sends: unknown[] = [];
    const thread: TurnSessionThread = {
      send: (input) => {
        sends.push(input);
        return Promise.resolve(runWithEvents([sendMessageEvent()]));
      },
      steer: () => {
        throw new Error("steer should not run when idle");
      },
    };

    const session = createTurnSession(thread);
    await expect(session.deliver("first")).resolves.toEqual({
      delivered: true,
      mode: "send",
    });
    await expect(session.deliver("second")).resolves.toEqual({
      delivered: true,
      mode: "send",
    });
    expect(sends).toEqual(["first", "second"]);
  });

  it("keeps the active gate through recovery send", async () => {
    const sends: unknown[] = [];
    const steers: unknown[] = [];
    let releaseFirst: (() => void) | undefined;

    const thread: TurnSessionThread = {
      send: (input) => {
        sends.push(input);
        if (sends.length === 1) {
          return new Promise<AgentTurn>((resolve) => {
            releaseFirst = () => {
              resolve(
                runWithEvents([
                  { text: "assistant-only", type: "assistant-output" },
                ])
              );
            };
          });
        }
        return Promise.resolve(runWithEvents([sendMessageEvent()]));
      },
      steer: (input) => {
        steers.push(input);
        return Promise.resolve(runWithEvents([]));
      },
    };

    const session = createTurnSession(thread);
    const first = session.deliver("hello");
    await Promise.resolve();
    await Promise.resolve();
    expect(session.isActive()).toBe(true);

    await expect(session.deliver("steer while first step")).resolves.toEqual({
      delivered: true,
      mode: "steer",
    });
    expect(steers).toEqual(["steer while first step"]);

    releaseFirst?.();
    await expect(first).resolves.toEqual({ delivered: true, mode: "send" });
    expect(sends).toEqual(["hello", TOOL_ONLY_DELIVERY_RECOVERY_PROMPT]);
  });
});

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
