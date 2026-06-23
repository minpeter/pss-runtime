import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./events";
import { collectAssistantText, streamAssistantText } from "./text-stream";
import type { AgentTurn } from "./turn";

function turnFromEvents(events: readonly AgentEvent[]): AgentTurn {
  let consumed = false;
  return {
    events(): AsyncIterable<AgentEvent> {
      if (consumed) {
        throw new Error("AgentTurn.events() can only be consumed once");
      }
      consumed = true;
      let index = 0;
      return {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          return {
            next(): Promise<IteratorResult<AgentEvent>> {
              if (index >= events.length) {
                return Promise.resolve({ done: true, value: undefined });
              }
              const value = events[index];
              index += 1;
              return Promise.resolve({ done: false, value });
            },
          };
        },
      };
    },
  };
}

describe("assistant text-stream helpers", () => {
  const events: readonly AgentEvent[] = [
    { type: "turn-start" },
    { type: "assistant-reasoning", text: "internal" },
    { type: "assistant-output", text: "Hello, " },
    { type: "tool-call", input: {}, toolCallId: "1", toolName: "noop" },
    { type: "assistant-output", text: "world" },
    { type: "turn-end" },
  ];

  it("yields only visible assistant text chunks in order", async () => {
    const chunks: string[] = [];
    for await (const chunk of streamAssistantText(turnFromEvents(events))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello, ", "world"]);
  });

  it("concatenates visible assistant text", async () => {
    expect(await collectAssistantText(turnFromEvents(events))).toBe(
      "Hello, world"
    );
  });

  it("consumes the turn stream once", async () => {
    const turn = turnFromEvents(events);
    await collectAssistantText(turn);

    await expect(collectAssistantText(turn)).rejects.toThrow(
      "AgentTurn.events() can only be consumed once"
    );
  });
});
