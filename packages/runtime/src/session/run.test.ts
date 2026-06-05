import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./events";
import { BufferedAgentRun } from "./run";

const expectPending = async (promise: Promise<unknown>) => {
  const marker = Symbol("pending");
  await expect(Promise.race([promise, Promise.resolve(marker)])).resolves.toBe(
    marker
  );
};

describe("AgentRun", () => {
  it("delivers events emitted before events consumption", async () => {
    const run = new BufferedAgentRun();
    run.emit({ type: "user-text", text: "hello" });
    run.emit({ type: "turn-end" });
    run.close();

    const events: AgentEvent[] = [];
    for await (const event of run.events()) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "user-text", text: "hello" },
      { type: "turn-end" },
    ]);
  });

  it("delivers events emitted after events consumption starts", async () => {
    const run = new BufferedAgentRun();
    const events: unknown[] = [];
    const collecting = (async () => {
      for await (const event of run.events()) {
        events.push(event);
      }
    })();

    run.emit({ type: "turn-start" });
    run.emit({ type: "turn-end" });
    run.close();
    await collecting;

    expect(events).toEqual([{ type: "turn-start" }, { type: "turn-end" }]);
  });

  it("keeps boundary emit pending until the consumer asks for another event", async () => {
    const run = new BufferedAgentRun();
    const iterator = run.events()[Symbol.asyncIterator]();

    const boundary = run.emitBoundary({ type: "step-end" });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "step-end" },
    });
    await expectPending(boundary);

    const nextEvent = iterator.next();
    await boundary;
    run.emit({ type: "turn-end" });

    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: { type: "turn-end" },
    });
  });

  it("rejects duplicate events readers", () => {
    const run = new BufferedAgentRun();
    run.events();
    expect(() => run.events()).toThrow(
      "AgentRun.events() can only be consumed once"
    );
  });

  it("returns the same iterator for repeated async iterator access", () => {
    const run = new BufferedAgentRun();
    const eventIterator = run.events();

    expect(eventIterator[Symbol.asyncIterator]()).toBe(
      eventIterator[Symbol.asyncIterator]()
    );
  });

  it("rejects concurrent next calls so consumers cannot prefetch", async () => {
    const run = new BufferedAgentRun();
    const iterator = run.events()[Symbol.asyncIterator]();

    const waitingNext = iterator.next();
    await expect(iterator.next()).rejects.toThrow(
      "AgentRun.events() does not allow concurrent next() calls"
    );

    run.emit({ type: "turn-start" });
    await expect(waitingNext).resolves.toEqual({
      done: false,
      value: { type: "turn-start" },
    });
  });

  it("rejects same-tick prefetch when a boundary event is already queued", async () => {
    const run = new BufferedAgentRun();
    const iterator = run.events()[Symbol.asyncIterator]();

    const boundary = run.emitBoundary({ type: "step-end" });
    const first = iterator.next();
    const second = iterator.next();

    await expect(second).rejects.toThrow(
      "AgentRun.events() does not allow concurrent next() calls"
    );
    await expectPending(boundary);
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: "step-end" },
    });
    await expectPending(boundary);

    const afterHandling = iterator.next();
    await boundary;
    run.emit({ type: "turn-end" });

    await expect(afterHandling).resolves.toEqual({
      done: false,
      value: { type: "turn-end" },
    });
  });

  it("return() settles pending boundary ack and pending next waiter", async () => {
    const run = new BufferedAgentRun();
    const iterator = run.events()[Symbol.asyncIterator]();

    const boundary = run.emitBoundary({ type: "step-start" });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "step-start" },
    });
    const waitingNext = iterator.next();

    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(boundary).resolves.toBeUndefined();
    await expect(waitingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("close() settles queued boundary acknowledgements", async () => {
    const run = new BufferedAgentRun();
    const boundary = run.emitBoundary({ type: "step-start" });
    await expectPending(boundary);

    run.close(undefined, "Session killed");

    await expect(boundary).resolves.toBeUndefined();
  });

  it("closes and discards queued events when the events iterator returns early", async () => {
    const run = new BufferedAgentRun();
    const iterator = run.events()[Symbol.asyncIterator]();

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
