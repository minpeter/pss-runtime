import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  sentUserText,
  steerRuntimeInput,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent thread runtime input windows", () => {
  it("orders event plugins around runtime input windows", async () => {
    const pluginCalls: string[] = [];
    const trace: string[] = [];
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      plugins: [
        {
          on: ({ event, history }) => {
            pluginCalls.push(`${event.type}:${history.length}`);
            trace.push(`plugin:${event.type}`);
          },
        },
      ],
      model: createCallbackModel(({ history }) => {
        trace.push(`llm:${calls}`);
        seenHistory.push([...history]);
        calls += 1;
        return Promise.resolve([
          assistantMessage(["SEED", "FIRST", "DONE"][calls - 1] ?? "DONE"),
        ]);
      }),
    });
    const thread = agent.thread("plugin-runtime-ordering");

    await collect(await thread.send("prior"));

    pluginCalls.length = 0;
    trace.length = 0;
    seenHistory.length = 0;

    const run = await thread.send("original");
    const events: AgentEvent[] = [];
    let addedTurnStart = false;
    let addedStepStart = false;
    let addedStepEnd = false;

    for await (const event of run.events()) {
      events.push(event);
      trace.push(`event:${event.type}`);

      if (event.type === "turn-start" && !addedTurnStart) {
        addedTurnStart = true;
        await thread.steer("turn runtime");
      }

      if (event.type === "step-start" && !addedStepStart) {
        addedStepStart = true;
        await thread.steer("step runtime");
      }

      if (event.type === "step-end" && !addedStepEnd) {
        addedStepEnd = true;
        await thread.steer("step-end runtime");
      }
    }

    const priorHistory = [
      userTextToModelMessage(userText("prior")),
      assistantMessage("SEED"),
    ];
    const firstStepHistory = [
      ...priorHistory,
      userTextToModelMessage(userText("original")),
      userTextToModelMessage(userText("turn runtime")),
      userTextToModelMessage(userText("step runtime")),
    ];
    const secondStepHistory = [
      ...firstStepHistory,
      assistantMessage("FIRST"),
      userTextToModelMessage(userText("step-end runtime")),
    ];
    const finalHistory = [...secondStepHistory, assistantMessage("DONE")];

    expect(pluginCalls).toEqual([
      "user-text:2",
      "turn-start:3",
      "runtime-input:3",
      "step-start:4",
      "runtime-input:4",
      "assistant-text:6",
      "step-end:6",
      "runtime-input:6",
      "step-start:7",
      "assistant-text:8",
      "step-end:8",
      "turn-end:8",
    ]);
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "runtime-input",
      "step-start",
      "runtime-input",
      "assistant-text",
      "step-end",
      "runtime-input",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(events).toContainEqual(
      steerRuntimeInput("turn runtime", "turn-start")
    );
    expect(events).toContainEqual(
      steerRuntimeInput("step runtime", "step-start")
    );
    expect(events).toContainEqual(
      steerRuntimeInput("step-end runtime", "step-end")
    );
    expect(seenHistory).toEqual([firstStepHistory, secondStepHistory]);
    expect(trace).toEqual([
      "plugin:user-text",
      "event:user-text",
      "plugin:turn-start",
      "event:turn-start",
      "plugin:runtime-input",
      "event:runtime-input",
      "plugin:step-start",
      "event:step-start",
      "plugin:runtime-input",
      "event:runtime-input",
      "llm:1",
      "plugin:assistant-text",
      "event:assistant-text",
      "plugin:step-end",
      "event:step-end",
      "plugin:runtime-input",
      "event:runtime-input",
      "plugin:step-start",
      "event:step-start",
      "llm:2",
      "plugin:assistant-text",
      "event:assistant-text",
      "plugin:step-end",
      "event:step-end",
      "plugin:turn-end",
      "event:turn-end",
    ]);
    expect(finalHistory).toEqual([
      ...priorHistory,
      userTextToModelMessage(userText("original")),
      userTextToModelMessage(userText("turn runtime")),
      userTextToModelMessage(userText("step runtime")),
      assistantMessage("FIRST"),
      userTextToModelMessage(userText("step-end runtime")),
      assistantMessage("DONE"),
    ]);
  });

  it("active thread.steer at turn-start and step-start is visible before the first LLM snapshot", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });
    const thread = agent.thread("early-steer");
    const run = await thread.send("original");
    const events: AgentEvent[] = [];
    let addedTurnStart = false;
    let addedStepStart = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "turn-start" && !addedTurnStart) {
        addedTurnStart = true;
        await thread.steer("turn runtime");
      }
      if (event.type === "step-start" && !addedStepStart) {
        addedStepStart = true;
        await thread.steer("step runtime");
      }
    }

    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("turn runtime")),
        userTextToModelMessage(userText("step runtime")),
      ],
    ]);
    expect(events).toEqual([
      sentUserText("original"),
      { type: "turn-start" },
      steerRuntimeInput("turn runtime", "turn-start"),
      { type: "step-start" },
      steerRuntimeInput("step runtime", "step-start"),
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });
});
