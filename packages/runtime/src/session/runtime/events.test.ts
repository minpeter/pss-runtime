import { describe, expect, it } from "vitest";
import type { AgentPlugin } from "../plugins/pipeline";
import { BufferedAgentRun } from "../protocol/run";
import { SessionEventDispatcher } from "./events";

function createDispatcher(
  plugins: readonly AgentPlugin[]
): SessionEventDispatcher {
  return new SessionEventDispatcher({
    history: () => [],
    plugins,
    signal: () => undefined,
  });
}

describe("SessionEventDispatcher.emitRunEvent", () => {
  it("returns transformed user-text and emits the transformed event", async () => {
    const transformPlugin: AgentPlugin = {
      on: ({ event }) => {
        if (event.type !== "user-text" || typeof event.text !== "string") {
          return;
        }
        return {
          action: "transform",
          event: { ...event, text: `TAG:${event.text}` },
        };
      },
    };
    const dispatcher = createDispatcher([transformPlugin]);
    const run = new BufferedAgentRun();

    const emitted = await dispatcher.emitRunEvent(run, {
      type: "user-text",
      text: "hello",
    });

    expect(emitted).toEqual({ type: "user-text", text: "TAG:hello" });
    const iterator = run.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      type: "user-text",
      text: "TAG:hello",
    });
    await iterator.return?.();
  });

  it("returns handled without emitting user-text to the run", async () => {
    const handledPlugin: AgentPlugin = {
      on: () => ({ action: "handled" }),
    };
    const dispatcher = createDispatcher([handledPlugin]);
    const run = new BufferedAgentRun();

    const emitted = await dispatcher.emitRunEvent(run, {
      type: "user-text",
      text: "hello",
    });

    expect(emitted).toBe("handled");
    run.close();
    const iterator = run.events()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});

describe("SessionEventDispatcher.emitObserverEvent", () => {
  it("emits observer events to the active run and plugins", async () => {
    const pluginEventTypes: string[] = [];
    const dispatcher = createDispatcher([
      {
        on: ({ event }) => {
          pluginEventTypes.push(event.type);
        },
      },
    ]);
    const run = new BufferedAgentRun();

    await dispatcher.emitObserverEvent(run, {
      text: "observer reasoning",
      type: "assistant-reasoning",
    });

    const iterator = run.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      text: "observer reasoning",
      type: "assistant-reasoning",
    });
    await iterator.return?.();
    expect(pluginEventTypes).toEqual(["assistant-reasoning"]);
  });

  it("buffers observer events during capture", async () => {
    const dispatcher = createDispatcher([]);
    const run = new BufferedAgentRun();

    const captured = await dispatcher.captureObserverEvents(run, async () => {
      await dispatcher.emitObserverEvent(run, {
        text: "captured reasoning",
        type: "assistant-reasoning",
      });
      return "ok";
    });

    expect(captured.value).toBe("ok");
    expect(captured.events).toEqual([
      { text: "captured reasoning", type: "assistant-reasoning" },
    ]);
    captured.release();
  });
});

describe("SessionEventDispatcher.emitRunBoundaryEvent", () => {
  it("ignores transform returns on boundary events", async () => {
    const transformPlugin: AgentPlugin = {
      on: () => ({
        action: "transform",
        event: { type: "user-text", text: "ignored" },
      }),
    };
    const dispatcher = createDispatcher([transformPlugin]);
    const run = new BufferedAgentRun();

    const iterator = run.events()[Symbol.asyncIterator]();
    const boundary = dispatcher.emitRunBoundaryEvent(run, {
      type: "turn-start",
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn-start" },
    });

    const waiting = iterator.next();
    await boundary;
    run.close();
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
  });
});
