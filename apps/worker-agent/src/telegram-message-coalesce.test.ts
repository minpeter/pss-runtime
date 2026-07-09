import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMessageCoalescer,
  MissingWaitUntilError,
} from "./telegram-message-coalesce";

const noopWaitUntil = (_task: Promise<unknown>) => {
  return;
};

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
    const waitUntilTasks: Promise<unknown>[] = [];
    const coalescer = createMessageCoalescer({
      quietMs: 500,
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
      { waitUntil: (task) => waitUntilTasks.push(task) }
    );
    await vi.advanceTimersByTimeAsync(400);
    coalescer.enqueue(
      "thread-1",
      {
        correlationId: "corr-b",
        message: { text: "photo caption" },
        subscribe: true,
      },
      { waitUntil: (task) => waitUntilTasks.push(task) }
    );
    expect(flushes).toEqual([]);
    expect(coalescer.pendingCount("thread-1")).toBe(2);
    expect(coalescer.correlationId("thread-1")).toBe("corr-a");

    const lifetime = coalescer.lifetime("thread-1");
    await vi.advanceTimersByTimeAsync(500);
    await lifetime;
    await Promise.all(waitUntilTasks);

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
    const coalescer = createMessageCoalescer({
      quietMs: 500,
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
      { waitUntil: noopWaitUntil }
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(coalescer.inFlightCount("thread-1")).toBe(1);
    expect(flushes).toEqual([["first"]]);

    // Second message while first flush is still running → new quiet batch.
    coalescer.enqueue(
      "thread-1",
      { message: { text: "second" } },
      { waitUntil: noopWaitUntil }
    );
    expect(coalescer.pendingCount("thread-1")).toBe(1);
    expect(flushes).toEqual([["first"]]);

    const lifetime = coalescer.lifetime("thread-1");
    await vi.advanceTimersByTimeAsync(500);
    // Concurrent flush starts for mid-turn steer path.
    expect(flushes).toEqual([["first"], ["second"]]);
    expect(coalescer.inFlightCount("thread-1")).toBe(1);

    releaseFirstFlush?.();
    await lifetime;

    expect(coalescer.inFlightCount("thread-1")).toBe(0);
    expect(coalescer.pendingCount("thread-1")).toBe(0);
  });

  it("requires waitUntil and reports flush failures", async () => {
    vi.useFakeTimers();
    const flushErrors: unknown[] = [];
    const coalescer = createMessageCoalescer({
      quietMs: 500,
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
      { waitUntil: noopWaitUntil }
    );
    const lifetime = coalescer.lifetime("thread-1");
    await vi.advanceTimersByTimeAsync(500);
    await lifetime;
    expect(flushErrors).toHaveLength(1);
    expect(flushErrors[0]).toEqual(expect.any(Error));
  });

  it("starts a new batch after the previous flush fully completes", async () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    const coalescer = createMessageCoalescer({
      quietMs: 500,
      onFlush: (_key, batch) => {
        flushes.push(batch.messages.map((message) => message.text ?? ""));
        return Promise.resolve();
      },
    });

    coalescer.enqueue(
      "thread-1",
      { message: { text: "a" } },
      { waitUntil: noopWaitUntil }
    );
    const firstLifetime = coalescer.lifetime("thread-1");
    await vi.advanceTimersByTimeAsync(500);
    await firstLifetime;
    expect(flushes).toEqual([["a"]]);

    coalescer.enqueue(
      "thread-1",
      { message: { text: "b" } },
      { waitUntil: noopWaitUntil }
    );
    const secondLifetime = coalescer.lifetime("thread-1");
    await vi.advanceTimersByTimeAsync(500);
    await secondLifetime;
    expect(flushes).toEqual([["a"], ["b"]]);
  });
});
