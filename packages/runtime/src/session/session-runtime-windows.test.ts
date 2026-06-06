import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import { assistantMessage, eventTypes, userText } from "../test-fixtures";
import type { AgentEvent } from "./events";
import { userTextToModelMessage } from "./mapping";
import { collect } from "./session.test-support";

describe("Agent session runtime input windows", () => {
  it("orders turn and step hooks around runtime input windows", async () => {
    const hookCalls: string[] = [];
    const trace: string[] = [];
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      hooks: {
        afterStep: ({ history, result, stepIndex }) => {
          hookCalls.push(`afterStep:${stepIndex}:${result}:${history.length}`);
          trace.push(`hook:afterStep:${stepIndex}`);
        },
        afterTurn: ({ history, input, result }) => {
          hookCalls.push(`${input.type}:afterTurn:${result}:${history.length}`);
          trace.push("hook:afterTurn");
          throw new Error("after turn failed");
        },
        beforeStep: ({ history, stepIndex }) => {
          hookCalls.push(`beforeStep:${stepIndex}:${history.length}`);
          trace.push(`hook:beforeStep:${stepIndex}`);
        },
        beforeTurn: ({ history, input }) => {
          hookCalls.push(`${input.type}:beforeTurn:${history.length}`);
          trace.push("hook:beforeTurn");
        },
      },
      llm: ({ history }) => {
        trace.push(`llm:${calls}`);
        seenHistory.push([...history]);
        calls += 1;
        return Promise.resolve([
          assistantMessage(["SEED", "FIRST", "DONE"][calls - 1] ?? "DONE"),
        ]);
      },
    });
    const session = agent.session("hook-runtime-ordering");

    await collect(await session.send("prior"));

    hookCalls.length = 0;
    trace.length = 0;
    seenHistory.length = 0;

    const run = await session.send("original");
    const events: AgentEvent[] = [];
    let addedTurnStart = false;
    let addedStepStart = false;
    let addedStepEnd = false;

    for await (const event of run.events()) {
      events.push(event);
      trace.push(`event:${event.type}`);

      if (event.type === "turn-start" && !addedTurnStart) {
        addedTurnStart = true;
        await session.steer("turn runtime");
      }

      if (event.type === "step-start" && !addedStepStart) {
        addedStepStart = true;
        await session.steer("step runtime");
      }

      if (event.type === "step-end" && !addedStepEnd) {
        addedStepEnd = true;
        await session.steer("step-end runtime");
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

    expect(hookCalls).toEqual([
      "user-text:beforeTurn:2",
      "beforeStep:0:4",
      "afterStep:0:completed:6",
      "beforeStep:1:7",
      "afterStep:1:completed:8",
      "user-text:afterTurn:completed:8",
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
    expect(events).toContainEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "turn runtime" },
      placement: "turn-start",
    });
    expect(events).toContainEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "step runtime" },
      placement: "step-start",
    });
    expect(events).toContainEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "step-end runtime" },
      placement: "step-end",
    });
    expect(seenHistory).toEqual([firstStepHistory, secondStepHistory]);
    expect(trace).toEqual([
      "hook:beforeTurn",
      "event:user-text",
      "event:turn-start",
      "event:runtime-input",
      "hook:beforeStep:0",
      "event:step-start",
      "event:runtime-input",
      "llm:1",
      "event:assistant-text",
      "hook:afterStep:0",
      "event:step-end",
      "event:runtime-input",
      "hook:beforeStep:1",
      "event:step-start",
      "llm:2",
      "event:assistant-text",
      "hook:afterStep:1",
      "event:step-end",
      "hook:afterTurn",
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

  it("active session.steer at turn-start and step-start is visible before the first LLM snapshot", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const session = agent.session("early-steer");
    const run = await session.send("original");
    const events: AgentEvent[] = [];
    let addedTurnStart = false;
    let addedStepStart = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "turn-start" && !addedTurnStart) {
        addedTurnStart = true;
        await session.steer("turn runtime");
      }
      if (event.type === "step-start" && !addedStepStart) {
        addedStepStart = true;
        await session.steer("step runtime");
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
      { type: "user-text", text: "original" },
      { type: "turn-start" },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "turn runtime" },
        placement: "turn-start",
      },
      { type: "step-start" },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "step runtime" },
        placement: "step-start",
      },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });
});
