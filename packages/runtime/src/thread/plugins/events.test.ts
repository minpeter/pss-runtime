import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent thread plugin events", () => {
  it("calls event plugins for queued turn events", async () => {
    const pluginCalls: string[] = [];
    const agent = new Agent({
      plugins: [
        {
          on: ({ event, history }) => {
            pluginCalls.push(`${event.type}:${history.length}`);
          },
        },
      ],
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    const events = await collect(await agent.send("hello"));

    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(pluginCalls).toEqual([
      "user-input:0",
      "turn-start:1",
      "step-start:1",
      "assistant-text:2",
      "step-end:2",
      "turn-end:2",
    ]);
  });

  it("lets plugins branch on emitted run events", async () => {
    const pluginEventTypes: string[] = [];
    const agent = new Agent({
      plugins: [
        {
          on: async ({ event }) => {
            if (event.type === "assistant-reasoning") {
              await Promise.resolve();
            }
            pluginEventTypes.push(event.type);
          },
        },
      ],
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    const events = await collect(await agent.send("hello"));

    expect(pluginEventTypes).toEqual(eventTypes(events));
  });

  it("commits successful output before terminal event plugin failures", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      plugins: [
        {
          on: ({ event }) => {
            if (event.type === "turn-end") {
              throw new Error("turn-end plugin failed");
            }
          },
        },
      ],
      model: createCallbackModel(({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${calls}`)]);
      }),
    });

    const firstEvents = await collect(
      await agent.thread("terminal-event").send("first")
    );
    const secondEvents = await collect(
      await agent.thread("terminal-event").send("second")
    );

    expect(eventTypes(firstEvents)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-error",
    ]);
    expect(eventTypes(secondEvents)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-error",
    ]);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("first")),
      assistantMessage("DONE 1"),
      userTextToModelMessage(userText("second")),
    ]);
  });
});
