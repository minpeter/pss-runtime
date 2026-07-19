import type { AgentEvent } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTuiRunner, formatEvent, formatTuiHeader } from "./tui-runner";

describe("TUI runner", () => {
  it("formats the header when compaction is disabled", () => {
    expect(
      formatTuiHeader({ autoCompaction: false, threadKey: "cwd:/repo/demo" })
    ).toBe(
      "\x1b[1mpss-next\x1b[0m \x1b[2m(thread cwd:/repo/demo \u00b7 compaction off \u00b7 Esc to interrupt \u00b7 Ctrl-C to quit)\x1b[0m"
    );
  });

  it("formats the header when compaction is enabled", () => {
    expect(
      formatTuiHeader({
        autoCompaction: { minMessages: 12, retainMessages: 4 },
        threadKey: "workspace:demo",
      })
    ).toBe(
      "\x1b[1mpss-next\x1b[0m \x1b[2m(thread workspace:demo \u00b7 compaction min=12 retain=4 \u00b7 Esc to interrupt \u00b7 Ctrl-C to quit)\x1b[0m"
    );
  });

  it("renders runtime input distinctly from human input", () => {
    expect(formatEvent({ text: "hello", type: "user-input" })).toBe(
      "\x1b[36myou\x1b[0m: hello"
    );
    expect(
      formatEvent({
        input: { text: "extra", type: "user-input" },
        placement: "step-end",
        type: "runtime-input",
      })
    ).toBe("\x1b[2mruntime: extra\x1b[0m");
  });

  it("starts idle submissions with thread.send and consumes the run", async () => {
    const run = createRun([
      { text: "hello", type: "user-input" },
      { type: "turn-end" },
    ]);
    const thread = {
      send: vi.fn().mockResolvedValue(run),
      steer: vi.fn().mockResolvedValue(run),
    };
    const lines: string[] = [];
    const runner = createTuiRunner({
      addLine: (line) => lines.push(line),
      requestRender: vi.fn(),
      thread,
    });

    runner.submit(" hello ");
    await run.done;

    expect(thread.send).toHaveBeenCalledWith("hello");
    expect(lines).toContain("\x1b[36myou\x1b[0m: hello");
    expect(runner.activeRun).toBeUndefined();
  });

  it("steers active submissions without sending a new turn", async () => {
    let releaseEvent: (() => void) | undefined;
    const run = createRun([
      { text: "initial", type: "user-input" },
      new Promise<AgentEvent>((resolve) => {
        releaseEvent = () => resolve({ type: "turn-end" });
      }),
    ]);
    const thread = {
      send: vi.fn().mockResolvedValue(run),
      steer: vi.fn().mockResolvedValue(run),
    };
    const runner = createTuiRunner({
      addLine: vi.fn(),
      requestRender: vi.fn(),
      thread,
    });

    runner.submit("initial");
    await run.firstEventRead;
    runner.submit(" extra ");
    releaseEvent?.();
    await run.done;

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(thread.steer).toHaveBeenCalledWith("extra");
    expect(runner.activeRun).toBeUndefined();
  });

  it("consumes a distinct run returned by active steering", async () => {
    let releaseActive: (() => void) | undefined;
    const activeRun = createRun([
      { text: "initial", type: "user-input" },
      new Promise<AgentEvent>((resolve) => {
        releaseActive = () => resolve({ type: "turn-end" });
      }),
    ]);
    const fallbackRun = createRun([
      { text: "fallback", type: "user-input" },
      { type: "turn-end" },
    ]);
    const lines: string[] = [];
    const thread = {
      send: vi.fn().mockResolvedValue(activeRun),
      steer: vi.fn().mockResolvedValue(fallbackRun),
    };
    const runner = createTuiRunner({
      addLine: (line) => lines.push(line),
      requestRender: vi.fn(),
      thread,
    });

    runner.submit("initial");
    await activeRun.firstEventRead;
    runner.submit(" fallback ");
    await fallbackRun.done;
    releaseActive?.();
    await activeRun.done;

    expect(thread.steer).toHaveBeenCalledWith("fallback");
    expect(lines).toContain("\x1b[36myou\x1b[0m: fallback");
    expect(runner.activeRun).toBeUndefined();
  });

  it("renders active steering errors", async () => {
    const run = createRun([
      { text: "initial", type: "user-input" },
      new Promise<AgentEvent>(() => undefined),
    ]);
    const lines: string[] = [];
    const thread = {
      send: vi.fn().mockResolvedValue(run),
      steer: vi.fn().mockRejectedValue(new Error("cannot steer")),
    };
    const runner = createTuiRunner({
      addLine: (line) => lines.push(line),
      requestRender: vi.fn(),
      thread,
    });

    runner.submit("initial");
    await run.firstEventRead;
    runner.submit(" extra ");
    await waitUntil(() => lines.includes("\x1b[31merror\x1b[0m: cannot steer"));
    run.stop();

    expect(thread.steer).toHaveBeenCalledWith("extra");
  });

  it("clears stale active runs when events consumption throws", async () => {
    const run = createRun([new Error("events failed")]);
    const runner = createTuiRunner({
      addLine: vi.fn(),
      requestRender: vi.fn(),
      thread: {
        send: vi.fn().mockResolvedValue(run),
        steer: vi.fn().mockResolvedValue(run),
      },
    });

    runner.submit("hello");
    await run.done;
    await waitUntil(() => runner.activeRun === undefined);

    expect(runner.activeRun).toBeUndefined();
  });

  it("clears active runs as soon as terminal turn events render", async () => {
    let releaseEvent: (() => void) | undefined;
    let releaseAfterTerminal: (() => void) | undefined;
    const run = createRun([
      { text: "initial", type: "user-input" },
      new Promise<AgentEvent>((resolve) => {
        releaseEvent = () => resolve({ type: "turn-abort" });
      }),
      new Promise<AgentEvent>((resolve) => {
        releaseAfterTerminal = () => resolve({ type: "step-start" });
      }),
    ]);
    const runner = createTuiRunner({
      addLine: vi.fn(),
      requestRender: vi.fn(),
      thread: {
        send: vi.fn().mockResolvedValue(run),
        steer: vi.fn().mockResolvedValue(run),
      },
    });

    runner.submit("initial");
    await run.firstEventRead;
    expect(runner.activeRun).toBe(run);

    releaseEvent?.();
    await run.eventsRead(2);
    await waitUntil(() => runner.activeRun === undefined);

    expect(runner.activeRun).toBeUndefined();
    releaseAfterTerminal?.();
    await run.done;
  });

  it("fails waitUntil assertions when the predicate never passes", async () => {
    await expect(waitUntil(() => false)).rejects.toThrow(
      "Timed out waiting for TUI runner test condition"
    );
  });

  it("routes assistant output to addMarkdown when provided", async () => {
    const run = createRun([
      { text: "**hi**", type: "assistant-output" },
      { type: "turn-end" },
    ]);
    const lines: string[] = [];
    const markdown: string[] = [];
    const runner = createTuiRunner({
      addLine: (line) => lines.push(line),
      addMarkdown: (text) => markdown.push(text),
      requestRender: vi.fn(),
      thread: {
        send: vi.fn().mockResolvedValue(run),
        steer: vi.fn().mockResolvedValue(run),
      },
    });

    runner.submit("go");
    await run.done;

    expect(markdown).toEqual(["**hi**"]);
    expect(lines.some((line) => line.includes("assistant"))).toBe(false);
  });

  it("falls back to formatted lines when addMarkdown is absent", async () => {
    const run = createRun([
      { text: "**hi**", type: "assistant-output" },
      { type: "turn-end" },
    ]);
    const lines: string[] = [];
    const runner = createTuiRunner({
      addLine: (line) => lines.push(line),
      requestRender: vi.fn(),
      thread: {
        send: vi.fn().mockResolvedValue(run),
        steer: vi.fn().mockResolvedValue(run),
      },
    });

    runner.submit("go");
    await run.done;

    expect(lines).toContain("\x1b[32massistant\x1b[0m: **hi**");
  });
});

function createRun(events: readonly EventItem[]): TestRun {
  let eventCount = 0;
  let firstEventReadResolve: (() => void) | undefined;
  let doneResolve: (() => void) | undefined;
  const eventWaiters = new Map<number, () => void>();
  let stopped = false;
  const firstEventRead = new Promise<void>((resolve) => {
    firstEventReadResolve = resolve;
  });
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const run: TestRun = {
    done,
    eventsRead: (count) =>
      eventCount >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => eventWaiters.set(count, resolve)),
    firstEventRead,
    stop: () => {
      stopped = true;
    },
    async *events() {
      try {
        for (const item of events) {
          if (stopped) {
            return;
          }
          const event = await item;
          if (event instanceof Error) {
            throw event;
          }
          eventCount += 1;
          firstEventReadResolve?.();
          for (const [count, resolve] of eventWaiters) {
            if (eventCount >= count) {
              eventWaiters.delete(count);
              resolve();
            }
          }
          yield event;
        }
      } finally {
        doneResolve?.();
      }
    },
  };

  return run;
}

type EventItem = AgentEvent | Error | Promise<AgentEvent>;

interface TestRun {
  readonly done: Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  readonly eventsRead: (count: number) => Promise<void>;
  readonly firstEventRead: Promise<void>;
  readonly stop: () => void;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for TUI runner test condition");
}
