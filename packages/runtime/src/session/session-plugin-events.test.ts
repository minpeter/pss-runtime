import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import {
  assistantMessage,
  eventTypes,
  sentUserText,
  userText,
} from "../test-fixtures";
import { userTextToModelMessage } from "./mapping";
import { AgentSession } from "./session";
import { collect } from "./session.test-support";
import { MemorySessionStore } from "./store/memory";

describe("Agent session plugin events", () => {
  it("calls event plugins for queued turn events", async () => {
    const pluginCalls: string[] = [];
    const agent = new Agent({
      plugins: [
        {
          events: {
            on: ({ event, history }) => {
              pluginCalls.push(`${event.type}:${history.length}`);
            },
          },
        },
      ],
      model: () => Promise.resolve([assistantMessage("DONE")]),
    });

    const events = await collect(await agent.send("hello"));

    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(pluginCalls).toEqual([
      "user-text:0",
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
          events: {
            on: async ({ event }) => {
              if (event.type === "subagent-job-start") {
                await Promise.resolve();
              }
              pluginEventTypes.push(event.type);
            },
          },
        },
      ],
      model: () => Promise.resolve([assistantMessage("DONE")]),
    });

    const events = await collect(await agent.send("hello"));

    expect(pluginEventTypes).toEqual(eventTypes(events));
  });

  it("routes observer events through event plugins", async () => {
    const pluginEventTypes: string[] = [];
    const session = new AgentSession(
      () => Promise.resolve([assistantMessage("DONE")]),
      { key: "observer-events", store: new MemorySessionStore() },
      [
        {
          events: {
            on: ({ event }) => {
              pluginEventTypes.push(event.type);
            },
          },
        },
      ]
    );

    const run = await session.send("hello");
    const iterator = run.events()[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual(sentUserText("hello"));
    expect((await iterator.next()).value).toEqual({ type: "turn-start" });

    await session.emitObserverEvent({
      run_in_background: false,
      subagent: "researcher",
      type: "subagent-job-start",
    });

    const events = [
      (await iterator.next()).value,
      (await iterator.next()).value,
    ];
    await iterator.return?.();

    expect(eventTypes(events)).toContain("subagent-job-start");
    expect(pluginEventTypes).toContain("subagent-job-start");
  });

  it("commits successful output before terminal event plugin failures", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      plugins: [
        {
          events: {
            on: ({ event }) => {
              if (event.type === "turn-end") {
                throw new Error("turn-end plugin failed");
              }
            },
          },
        },
      ],
      model: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${calls}`)]);
      },
    });

    const firstEvents = await collect(
      await agent.session("terminal-event").send("first")
    );
    const secondEvents = await collect(
      await agent.session("terminal-event").send("second")
    );

    expect(eventTypes(firstEvents)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-error",
    ]);
    expect(eventTypes(secondEvents)).toEqual([
      "user-text",
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
