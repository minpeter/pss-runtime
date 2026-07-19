import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { definePlugin } from "../../plugins/api";
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
    const observerPlugin = definePlugin((pss) => {
      pss.on("input.accept", (event, { history }) => {
        pluginCalls.push(`${event.type}:${history.length}`);
        return;
      });
      pss.on("turn.start", (event, { history }) => {
        pluginCalls.push(`${event.type}:${history.length}`);
      });
      pss.on("step.start", (event, { history }) => {
        pluginCalls.push(`${event.type}:${history.length}`);
      });
      pss.on("message.end", (event, { history }) => {
        pluginCalls.push(`${event.type}:${history.length}`);
      });
      pss.on("step.end", (event, { history }) => {
        pluginCalls.push(`${event.type}:${history.length}`);
      });
      pss.on("turn.end", (event, { history }) => {
        pluginCalls.push(`${event.type}:${history.length}`);
      });
    });
    const agent = await createAgent({
      plugins: [observerPlugin],
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    const events = await collect(await agent.send("hello"));

    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "assistant-output",
      "step-end",
      "turn-end",
    ]);
    expect(pluginCalls).toEqual([
      "user-input:0",
      "turn-start:1",
      "step-start:1",
      "assistant-output:2",
      "step-end:2",
      "turn-end:2",
    ]);
  });

  it("lets plugins branch on emitted run events", async () => {
    const pluginEventTypes: string[] = [];
    const observerPlugin = definePlugin((pss) => {
      pss.on("input.accept", (event) => {
        pluginEventTypes.push(event.type);
        return;
      });
      pss.on("turn.start", (event) => {
        pluginEventTypes.push(event.type);
      });
      pss.on("step.start", (event) => {
        pluginEventTypes.push(event.type);
      });
      pss.on("message.end", (event) => {
        pluginEventTypes.push(event.type);
      });
      pss.on("step.end", (event) => {
        pluginEventTypes.push(event.type);
      });
      pss.on("turn.end", (event) => {
        pluginEventTypes.push(event.type);
      });
    });
    const agent = await createAgent({
      plugins: [observerPlugin],
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
    const agent = await createAgent({
      plugins: [
        definePlugin((pss) => {
          pss.on("turn.end", () => {
            throw new Error("turn-end plugin failed");
          });
        }),
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
      "assistant-output",
      "step-end",
      "turn-error",
    ]);
    expect(eventTypes(secondEvents)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "assistant-output",
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
