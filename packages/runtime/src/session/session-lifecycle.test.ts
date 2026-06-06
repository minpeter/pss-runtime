import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import {
  assistantMessage,
  createDeferred,
  eventTypes,
  userText,
} from "../test-fixtures";
import { userTextToModelMessage } from "./mapping";
import { collect } from "./session.test-support";

const timeoutMarker = Symbol("timeout");

describe("Agent session lifecycle", () => {
  it("idle session.steer starts a new run after turn-end", async () => {
    let calls = 0;
    const agent = new Agent({
      llm: () => {
        calls += 1;
        return Promise.resolve([assistantMessage("DONE")]);
      },
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
      llm: () => {
        calls += 1;
        return Promise.reject(new Error("model unavailable"));
      },
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
      llm: async () => {
        llmStarted.resolve();
        await llmGate.promise;
        return [assistantMessage("DONE")];
      },
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

  it("rejects runtime input after kill and settles queued runs", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const session = new Agent({
      llm: async () => {
        llmStarted.resolve();
        await llmGate.promise;
        return [assistantMessage("DONE")];
      },
    }).session("kill-terminal");
    const firstRun = await session.send("first");
    const secondRun = await session.send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);

    await llmStarted.promise;
    session.kill();
    llmGate.resolve();

    expect(eventTypes(await firstEvents)).toContain("turn-error");
    expect(eventTypes(await secondEvents)).toEqual(["user-text", "turn-error"]);
    await expect(session.steer("late")).rejects.toThrow("Session killed");
  });

  it("closes the active run when a killed session has a pending model call", async () => {
    const llmStarted = createDeferred();
    const agent = new Agent({
      llm: () => {
        llmStarted.resolve();
        return new Promise<never>(() => undefined);
      },
    });
    const session = agent.session("kill-pending-model");
    const collecting = collect(await session.send("hello"));
    await llmStarted.promise;

    session.kill();

    const events = await withShortTimeout(collecting);
    if (events === timeoutMarker) {
      throw new Error("session.kill() did not close the active run");
    }
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
  });

  it("closes the active run when a killed session has a pending afterTurn hook", async () => {
    const afterTurnStarted = createDeferred();
    const agent = new Agent({
      hooks: {
        afterTurn: () => {
          afterTurnStarted.resolve();
          return new Promise<never>(() => undefined);
        },
      },
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });
    const session = agent.session("kill-pending-after-turn");
    const collecting = collect(await session.send("hello"));
    await afterTurnStarted.promise;

    session.kill();

    const events = await withShortTimeout(collecting);
    if (events === timeoutMarker) {
      throw new Error("session.kill() did not close the afterTurn run");
    }
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-error",
    ]);
  });

  it("does not persist an active turn after session delete", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: async ({ history }) => {
        seenHistory.push([...history]);
        if (seenHistory.length === 1) {
          llmStarted.resolve();
          await llmGate.promise;
        }
        return [assistantMessage("DONE")];
      },
    });
    const session = agent.session("delete-active");
    const deletedRun = collect(await session.send("first"));

    await llmStarted.promise;
    await session.delete();
    llmGate.resolve();
    await deletedRun;
    await collect(await agent.session("delete-active").send("fresh"));

    expect(seenHistory.at(-1)).toEqual([
      userTextToModelMessage(userText("fresh")),
    ]);
  });

  it("rejects runtime input after events return", async () => {
    const agent = new Agent({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });
    const run = await agent.send("initial");
    const iterator = run.events()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "user-text", text: "initial" },
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
      llm: () => Promise.reject(new Error("model unavailable")),
    });

    const events = await collect(await agent.send("fail"));

    expect(events).toEqual([
      { type: "user-text", text: "fail" },
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
      llm: async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          firstLlmStarted.resolve();
          await firstLlmCall.promise;
        }
        return [assistantMessage("DONE")];
      },
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

function withShortTimeout<T>(
  promise: Promise<T>
): Promise<T | typeof timeoutMarker> {
  return Promise.race([
    promise,
    new Promise<typeof timeoutMarker>((resolve) => {
      setTimeout(() => resolve(timeoutMarker), 100);
    }),
  ]);
}
