import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  steerRuntimeInput,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent thread runtime input queueing", () => {
  it("active thread.steer preserves FIFO order for multiple additions in one window", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });
    const thread = agent.thread("steer-fifo");
    const run = await thread.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await thread.steer("first");
        await thread.steer("second");
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    expect(runtimeInputs).toEqual([
      steerRuntimeInput("first", "step-start"),
      steerRuntimeInput("second", "step-start"),
    ]);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });

  it("active thread.steer preserves FIFO order for concurrent additions in one window", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });
    const thread = agent.thread("steer-concurrent-fifo");
    const run = await thread.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await Promise.all([
          thread.steer("first"),
          thread.steer("second"),
          thread.steer("third"),
        ]);
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    expect(runtimeInputs).toEqual([
      steerRuntimeInput("first", "step-start"),
      steerRuntimeInput("second", "step-start"),
      steerRuntimeInput("third", "step-start"),
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

  it("keeps active thread.send input as a separate turn while thread.steer affects the active turn", async () => {
    const stepGate = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const thread = new Agent({
      model: createCallbackModel(async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          await stepGate.promise;
          return [assistantMessage("ACTIVE")];
        }
        return [assistantMessage("QUEUED")];
      }),
    }).thread("queue-separation");
    const firstRun = await thread.send("first");
    const secondRun = await thread.send("second");
    const firstEvents: AgentEvent[] = [];
    let added = false;
    const firstCollecting = (async () => {
      for await (const event of firstRun.events()) {
        firstEvents.push(event);
        if (event.type === "step-start" && !added) {
          added = true;
          await thread.steer("extra");
          stepGate.resolve();
        }
      }
    })();
    const secondEvents = collect(secondRun);

    await Promise.all([firstCollecting, secondEvents]);

    expect(firstEvents).toContainEqual(
      steerRuntimeInput("extra", "step-start")
    );
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
