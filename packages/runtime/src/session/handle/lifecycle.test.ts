import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  sentUserText,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect } from "./test-support";

describe("Agent session lifecycle", () => {
  it("idle session.steer starts a new run after turn-end", async () => {
    let calls = 0;
    const agent = new Agent({
      model: createCallbackModel(() => {
        calls += 1;
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });
    const session = agent.session("idle-steer-after-turn-end");
    const run = await session.send("initial");

    await collect(run);

    await collect(await session.steer("late"));
    expect(calls).toBe(2);
  });

  it("idle session.steer starts a new run after model turn-error", async () => {
    let calls = 0;
    const agent = new Agent({
      model: createCallbackModel(() => {
        calls += 1;
        return Promise.reject(new Error("model unavailable"));
      }),
    });
    const session = agent.session("idle-steer-after-turn-error");
    const run = await session.send("initial");

    expect(eventTypes(await collect(run))).toContain("turn-error");

    expect(eventTypes(await collect(await session.steer("late")))).toContain(
      "turn-error"
    );
    expect(calls).toBe(2);
  });

  it("idle session.steer starts a new run after interrupt turn-abort", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const session = new Agent({
      model: createCallbackModel(async () => {
        llmStarted.resolve();
        await llmGate.promise;
        return [assistantMessage("DONE")];
      }),
    }).session("interrupt-terminal");
    const run = await session.send("initial");
    const events = collect(run);

    await llmStarted.promise;
    session.interrupt();
    llmGate.resolve();

    expect(eventTypes(await events)).toContain("turn-abort");
    expect(eventTypes(await collect(await session.steer("late")))).toContain(
      "turn-end"
    );
  });

  it("rejects runtime input after events return", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const run = await agent.send("initial");
    const iterator = run.events()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: sentUserText("initial"),
    });
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(eventTypes(await collect(await agent.send("late")))).toContain(
      "turn-end"
    );
  });

  it("emits turn-error in the run when the LLM fails", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.reject(new Error("model unavailable"))
      ),
    });

    const events = await collect(await agent.send("fail"));

    expect(events).toEqual([
      sentUserText("fail"),
      { type: "turn-start" },
      { type: "step-start" },
      { type: "turn-error", message: "model unavailable" },
    ]);
  });

  it("interrupts the active run without aborting queued input", async () => {
    const firstLlmCall = createDeferred();
    const firstLlmStarted = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const session = new Agent({
      model: createCallbackModel(async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          firstLlmStarted.resolve();
          await firstLlmCall.promise;
        }
        return [assistantMessage("DONE")];
      }),
    }).session("interrupt");

    const firstRun = await session.send("first");
    const secondRun = await session.send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);

    await firstLlmStarted.promise;
    session.interrupt();
    firstLlmCall.resolve();

    expect(eventTypes(await firstEvents)).toContain("turn-abort");
    expect(eventTypes(await secondEvents)).toContain("turn-end");
    expect(calls).toBe(2);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("first")),
      userTextToModelMessage(userText("second")),
    ]);
  });
});
