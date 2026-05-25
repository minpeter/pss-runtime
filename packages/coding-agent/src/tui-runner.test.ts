import type { AgentEvent, AgentRun } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTuiRunner, formatEvent } from "./tui-runner";

describe("TUI runner", () => {
  it("renders runtime input distinctly from human input", () => {
    expect(formatEvent({ text: "hello", type: "user-text" })).toBe(
      "\x1b[36myou\x1b[0m: hello"
    );
    expect(
      formatEvent({
        input: { text: "extra", type: "user-text" },
        placement: "step-end",
        type: "runtime-input",
      })
    ).toBe("\x1b[2mruntime: extra\x1b[0m");
  });

  it("starts idle submissions with session.send and consumes the run", async () => {
    const run = createRun([{ text: "hello", type: "user-text" }, { type: "turn-end" }]);
    const session = { send: vi.fn().mockResolvedValue(run) };
    const lines: string[] = [];
    const runner = createTuiRunner({
      addLine: (line) => lines.push(line),
      requestRender: vi.fn(),
      session,
    });

    runner.submit(" hello ");
    await run.done;

    expect(session.send).toHaveBeenCalledWith("hello");
    expect(lines).toContain("\x1b[36myou\x1b[0m: hello");
    expect(runner.activeRun).toBeUndefined();
  });

  it("adds active submissions to the current run without sending a new turn", async () => {
    let releaseStream: (() => void) | undefined;
    const run = createRun([
      { text: "initial", type: "user-text" },
      new Promise<AgentEvent>((resolve) => {
        releaseStream = () => resolve({ type: "turn-end" });
      }),
    ]);
    const session = { send: vi.fn().mockResolvedValue(run) };
    const runner = createTuiRunner({
      addLine: vi.fn(),
      requestRender: vi.fn(),
      session,
    });

    runner.submit("initial");
    await run.firstEventRead;
    runner.submit(" extra ");
    releaseStream?.();
    await run.done;

    expect(session.send).toHaveBeenCalledTimes(1);
    expect(run.addInput).toHaveBeenCalledWith("extra");
    expect(runner.activeRun).toBeUndefined();
  });

  it("clears stale active runs when stream consumption throws", async () => {
    const run = createRun([new Error("stream failed")]);
    const runner = createTuiRunner({
      addLine: vi.fn(),
      requestRender: vi.fn(),
      session: { send: vi.fn().mockResolvedValue(run) },
    });

    runner.submit("hello");
    await run.done;
    await waitUntil(() => runner.activeRun === undefined);

    expect(runner.activeRun).toBeUndefined();
  });

  it("clears active runs as soon as terminal turn events render", async () => {
    let releaseStream: (() => void) | undefined;
    let releaseAfterTerminal: (() => void) | undefined;
    const run = createRun([
      { text: "initial", type: "user-text" },
      new Promise<AgentEvent>((resolve) => {
        releaseStream = () => resolve({ type: "turn-abort" });
      }),
      new Promise<AgentEvent>((resolve) => {
        releaseAfterTerminal = () => resolve({ type: "step-start" });
      }),
    ]);
    const runner = createTuiRunner({
      addLine: vi.fn(),
      requestRender: vi.fn(),
      session: { send: vi.fn().mockResolvedValue(run) },
    });

    runner.submit("initial");
    await run.firstEventRead;
    expect(runner.activeRun).toBe(run);

    releaseStream?.();
    await run.eventsRead(2);
    await waitUntil(() => runner.activeRun === undefined);

    expect(runner.activeRun).toBeUndefined();
    releaseAfterTerminal?.();
    await run.done;
  });
});

function createRun(events: readonly StreamItem[]): TestRun {
  const addInput = vi.fn().mockResolvedValue(undefined);
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
    addInput,
    done,
    eventsRead: (count) =>
      eventCount >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => eventWaiters.set(count, resolve)),
    firstEventRead,
    input: { add: addInput },
    stop: () => {
      stopped = true;
    },
    stream: async function* () {
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

type StreamItem = AgentEvent | Error | Promise<AgentEvent>;

interface TestRun extends AgentRun {
  readonly addInput: ReturnType<typeof vi.fn>;
  readonly done: Promise<void>;
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
}
