import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import { assistantMessage, createDeferred, userText } from "../test-fixtures";
import type { AgentEvent } from "./events";
import { userTextToModelMessage } from "./mapping";
import { collect } from "./session.test-support";

describe("Agent session runtime input queueing", () => {
  it("active session.steer preserves FIFO order for multiple additions in one window", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const session = agent.session("steer-fifo");
    const run = await session.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await session.steer("first");
        await session.steer("second");
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    expect(runtimeInputs).toEqual([
      {
        type: "runtime-input",
        input: { type: "user-text", text: "first" },
        placement: "step-start",
      },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "second" },
        placement: "step-start",
      },
    ]);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });

  it("active session.steer preserves FIFO order for concurrent additions in one window", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const session = agent.session("steer-concurrent-fifo");
    const run = await session.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await Promise.all([
          session.steer("first"),
          session.steer("second"),
          session.steer("third"),
        ]);
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    expect(runtimeInputs).toEqual([
      {
        type: "runtime-input",
        input: { type: "user-text", text: "first" },
        placement: "step-start",
      },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "second" },
        placement: "step-start",
      },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "third" },
        placement: "step-start",
      },
    ]);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("second")),
        userTextToModelMessage(userText("third")),
      ],
    ]);
  });

  it("keeps active session.send input as a separate turn while session.steer affects the active turn", async () => {
    const stepGate = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const session = new Agent({
      llm: async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          await stepGate.promise;
          return [assistantMessage("ACTIVE")];
        }
        return [assistantMessage("QUEUED")];
      },
    }).session("queue-separation");
    const firstRun = await session.send("first");
    const secondRun = await session.send("second");
    const firstEvents: AgentEvent[] = [];
    let added = false;
    const firstCollecting = (async () => {
      for await (const event of firstRun.events()) {
        firstEvents.push(event);
        if (event.type === "step-start" && !added) {
          added = true;
          await session.steer("extra");
          stepGate.resolve();
        }
      }
    })();
    const secondEvents = collect(secondRun);

    await Promise.all([firstCollecting, secondEvents]);

    expect(firstEvents).toContainEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "extra" },
      placement: "step-start",
    });
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("extra")),
      ],
      [
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("extra")),
        assistantMessage("ACTIVE"),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });
});
