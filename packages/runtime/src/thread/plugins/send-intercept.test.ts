import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { definePlugin } from "../../plugins/api";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";

describe("thread.send intercept", () => {
  it("queues transformed user-input into model history", async () => {
    const seenHistory: ModelMessage[][] = [];
    const tagPlugin = definePlugin((pss) => {
      pss.on("input.accept", (event) => {
        if (
          event.type !== "user-input" ||
          !("text" in event) ||
          typeof event.text !== "string"
        ) {
          return;
        }
        return {
          action: "transform",
          value: { ...event, text: `TAG:${event.text}` },
        };
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
      plugins: [tagPlugin],
    });

    await collect(await agent.send("hello"));

    expect(seenHistory[0]).toEqual([
      userTextToModelMessage(userText("TAG:hello")),
    ]);
  });

  it("skips turn-start when send input is handled", async () => {
    const handledPlugin = definePlugin((pss) => {
      pss.on("input.accept", () => ({ action: "handled" }));
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [handledPlugin],
    });

    const events = await collect(await agent.send("hello"));

    expect(events.map((event) => event.type)).toEqual([]);
  });
});
