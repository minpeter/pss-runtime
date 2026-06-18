import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { AgentPlugin } from "../../plugins";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";

describe("session.send intercept", () => {
  it("queues transformed user-text into model history", async () => {
    const seenHistory: ModelMessage[][] = [];
    const transformPlugin: AgentPlugin = {
      on: ({ event }) => {
        if (event.type !== "user-text" || typeof event.text !== "string") {
          return;
        }
        return {
          action: "transform",
          event: { ...event, text: `TAG:${event.text}` },
        };
      },
    };
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
      plugins: [transformPlugin],
    });

    await collect(await agent.send("hello"));

    expect(seenHistory[0]).toEqual([
      userTextToModelMessage(userText("TAG:hello")),
    ]);
  });

  it("skips turn-start when send input is handled", async () => {
    const handledPlugin: AgentPlugin = {
      on: () => ({ action: "handled" }),
    };
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [handledPlugin],
    });

    const events = await collect(await agent.send("hello"));

    expect(eventTypes(events)).toEqual([]);
  });
});
