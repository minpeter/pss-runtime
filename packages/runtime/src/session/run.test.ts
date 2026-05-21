import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./events";
import { BufferedAgentRun } from "./run";

describe("AgentRun", () => {
  it("buffers events emitted before stream consumption", async () => {
    const run = new BufferedAgentRun();
    run.emit({ type: "user-text", text: "hello" });
    run.emit({ type: "turn-end" });
    run.close();

    const events: AgentEvent[] = [];
    for await (const event of run.stream()) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "user-text", text: "hello" },
      { type: "turn-end" },
    ]);
  });

  it("delivers events emitted after stream consumption starts", async () => {
    const run = new BufferedAgentRun();
    const events: unknown[] = [];
    const collecting = (async () => {
      for await (const event of run.stream()) {
        events.push(event);
      }
    })();

    run.emit({ type: "turn-start" });
    run.emit({ type: "turn-end" });
    run.close();
    await collecting;

    expect(events).toEqual([{ type: "turn-start" }, { type: "turn-end" }]);
  });

  it("rejects duplicate stream readers", () => {
    const run = new BufferedAgentRun();
    run.stream();
    expect(() => run.stream()).toThrow("can only be consumed once");
  });

  it("closes and discards buffered events when the stream returns early", async () => {
    const run = new BufferedAgentRun();
    const iterator = run.stream()[Symbol.asyncIterator]();

    run.emit({ type: "turn-start" });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn-start" },
    });

    run.emit({ type: "step-start" });
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    run.emit({ type: "turn-end" });

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
