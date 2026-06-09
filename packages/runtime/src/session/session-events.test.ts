import { describe, expect, it } from "vitest";
import type { AgentPlugin } from "../plugins";
import { BufferedAgentRun } from "./run";
import { SessionEventDispatcher } from "./session-events";

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
