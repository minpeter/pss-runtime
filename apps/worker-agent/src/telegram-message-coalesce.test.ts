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

  it("returns immediately from enqueue without waiting for flush", async () => {
    vi.useFakeTimers();
    let flushed = false;
    const coalescer = createMessageCoalescer({
      quietMs: 500,
      onFlush: () => {
        flushed = true;
        return Promise.resolve();
      },
    });

    coalescer.enqueue(
      "thread-1",
      { message: { text: "a" } },
      { waitUntil: noopWaitUntil }
    );
    expect(flushed).toBe(false);
    expect(coalescer.pendingCount("thread-1")).toBe(1);

    const lifetime = coalescer.lifetime("thread-1");
    await vi.advanceTimersByTimeAsync(500);
    await lifetime;
    expect(flushed).toBe(true);
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
