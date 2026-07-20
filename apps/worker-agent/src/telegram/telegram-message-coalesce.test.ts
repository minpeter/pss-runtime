import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMessageCoalescer,
  MissingWaitUntilError,
} from "./telegram-message-coalesce";

function trackWaitUntil(): {
  readonly tasks: Promise<unknown>[];
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly all: () => Promise<unknown[]>;
} {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    waitUntil: (task) => {
      tasks.push(task);
    },
    all: () => Promise.all(tasks),
  };
}

describe("createMessageCoalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets the quiet window and flushes one batch with all messages", async () => {
    vi.useFakeTimers();
    const flushes: Array<{
      key: string;
      texts: string[];
      correlationId?: string;
    }> = [];
    const tracked = trackWaitUntil();
    const coalescer = createMessageCoalescer({
      quietMs: 500,
      delay: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      onFlush: (key, batch) => {
        flushes.push({
          key,
          texts: batch.messages.map((message) => message.text ?? ""),
          ...(batch.correlationId
            ? { correlationId: batch.correlationId }
            : {}),
        });
        return Promise.resolve();
      },
    });

    coalescer.enqueue(
      "thread-1",
      { correlationId: "corr-a", message: { text: "hello" } },
      { waitUntil: tracked.waitUntil }
    );
    await vi.advanceTimersByTimeAsync(400);
    coalescer.enqueue(
      "thread-1",
      {
        correlationId: "corr-b",
        message: { text: "photo caption" },
        subscribe: true,
      },
      { waitUntil: tracked.waitUntil }
    );
    expect(flushes).toEqual([]);
    expect(coalescer.pendingCount("thread-1")).toBe(2);
    expect(coalescer.correlationId("thread-1")).toBe("corr-a");
    expect(coalescer.generation("thread-1")).toBe(2);
    expect(tracked.tasks).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(500);
    await tracked.all();

    expect(flushes).toEqual([
      {
        key: "thread-1",
        texts: ["hello", "photo caption"],
        correlationId: "corr-a",
      },
    ]);
    expect(coalescer.pendingCount("thread-1")).toBe(0);
  });

  it("allows a concurrent flush so mid-turn messages can steer", async () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    let releaseFirstFlush: (() => void) | undefined;
    let blockNextFlush = true;
    const tracked = trackWaitUntil();
    const coalescer = createMessageCoalescer({
      quietMs: 500,
      delay: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      onFlush: (_key, batch) => {
        flushes.push(batch.messages.map((message) => message.text ?? ""));
        if (blockNextFlush) {
          blockNextFlush = false;
          return new Promise((resolve) => {
            releaseFirstFlush = resolve;
          });
        }
        return Promise.resolve();
      },
    });

    coalescer.enqueue(
      "thread-1",
      { message: { text: "first" } },
      { waitUntil: tracked.waitUntil }
    );
    await vi.advanceTimersByTimeAsync(500);
    // Let first quiet work reach onFlush.
    await Promise.resolve();
    await Promise.resolve();
    expect(coalescer.inFlightCount("thread-1")).toBe(1);
    expect(flushes).toEqual([["first"]]);

    // Second message while first flush is still running → new quiet batch.
    coalescer.enqueue(
      "thread-1",
      { message: { text: "second" } },
      { waitUntil: tracked.waitUntil }
    );
    expect(coalescer.pendingCount("thread-1")).toBe(1);
    expect(flushes).toEqual([["first"]]);

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();
    // Concurrent flush starts for mid-turn steer path.
    expect(flushes).toEqual([["first"], ["second"]]);
    expect(coalescer.inFlightCount("thread-1")).toBe(1);

    releaseFirstFlush?.();
    await tracked.all();

    expect(coalescer.inFlightCount("thread-1")).toBe(0);
    expect(coalescer.pendingCount("thread-1")).toBe(0);
  });

  it("requires waitUntil and reports flush failures", async () => {
    vi.useFakeTimers();
    const flushErrors: unknown[] = [];
    const tracked = trackWaitUntil();
    const coalescer = createMessageCoalescer({
      quietMs: 500,
      delay: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      onFlush: () => Promise.reject(new Error("flush boom")),
      onFlushError: (_key, error) => {
        flushErrors.push(error);
      },
    });

    expect(() =>
      coalescer.enqueue("thread-1", { message: { text: "a" } })
    ).toThrow(MissingWaitUntilError);

    coalescer.enqueue(
      "thread-1",
      { message: { text: "a" } },
      { waitUntil: tracked.waitUntil }
    );
    await vi.advanceTimersByTimeAsync(500);
    await tracked.all();
    expect(flushErrors).toHaveLength(1);
    expect(flushErrors[0]).toEqual(expect.any(Error));
  });

  it("starts a new batch after the previous flush fully completes", async () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    const firstTracked = trackWaitUntil();
    const coalescer = createMessageCoalescer({
      quietMs: 500,
      delay: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      onFlush: (_key, batch) => {
        flushes.push(batch.messages.map((message) => message.text ?? ""));
        return Promise.resolve();
      },
    });

    coalescer.enqueue(
      "thread-1",
      { message: { text: "a" } },
      { waitUntil: firstTracked.waitUntil }
    );
    await vi.advanceTimersByTimeAsync(500);
    await firstTracked.all();
    expect(flushes).toEqual([["a"]]);

    const secondTracked = trackWaitUntil();
    coalescer.enqueue(
      "thread-1",
      { message: { text: "b" } },
      { waitUntil: secondTracked.waitUntil }
    );
    await vi.advanceTimersByTimeAsync(500);
    await secondTracked.all();
    expect(flushes).toEqual([["a"], ["b"]]);
  });

  it("settles superseded quiet work without flushing twice", async () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    const tracked = trackWaitUntil();
    const coalescer = createMessageCoalescer({
      quietMs: 500,
      delay: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      onFlush: (_key, batch) => {
        flushes.push(batch.messages.map((message) => message.text ?? ""));
        return Promise.resolve();
      },
    });

    coalescer.enqueue(
      "thread-1",
      { message: { text: "a" } },
      { waitUntil: tracked.waitUntil }
    );
    coalescer.enqueue(
      "thread-1",
      { message: { text: "b" } },
      { waitUntil: tracked.waitUntil }
    );
    expect(tracked.tasks).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(500);
    await tracked.all();

    expect(flushes).toEqual([["a", "b"]]);
  });
});
