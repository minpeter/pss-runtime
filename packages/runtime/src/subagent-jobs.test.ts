import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";
import { startBackgroundJob } from "./subagent-jobs";
import type { RuntimeInputSink, Subagent, SubagentJob } from "./subagent-types";

const parentSessionKey = "parent:default:subagent:researcher";

describe("subagent background jobs", () => {
  it("rejects new background jobs when the active job limit is full", async () => {
    const jobs = new Map<string, SubagentJob>();
    const runtimeInputs: string[] = [];
    let interruptCount = 0;
    const parentSession: RuntimeInputSink = {
      emitObserverEvent: () => Promise.resolve(),
      enqueueRuntimeInput: (input) => {
        if (input.type === "user-text" && typeof input.text === "string") {
          runtimeInputs.push(input.text);
        }
      },
    };
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => {
          interruptCount += 1;
        },
        send: async () => createDelayedTextRun("STALE RESULT"),
      }),
    };

    const launches = await Promise.all(
      Array.from({ length: 65 }, (_value, index) =>
        startBackgroundJob({
          abortSignal: new AbortController().signal,
          jobs,
          parentSession,
          prompt: { text: `research ${index}`, type: "user-text" },
          registerCleanup: () => () => undefined,
          sessionKey: `${parentSessionKey}:${index}`,
          subagent,
        })
      )
    );

    expect(interruptCount).toBe(0);
    expect(jobs.has(launches[0]?.task_id ?? "")).toBe(true);
    expect(jobs.size).toBe(64);
    expect(launches.at(-1)).toEqual(
      expect.objectContaining({ status: "cancelled" })
    );
    expect(runtimeInputs.join("\n")).not.toContain(launches[0]?.task_id);
  });

  it("allows new background jobs when retained jobs are completed", async () => {
    const jobs = new Map<string, SubagentJob>();
    const parentSession: RuntimeInputSink = {
      emitObserverEvent: () => Promise.resolve(),
      enqueueRuntimeInput: () => undefined,
    };
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => undefined,
        send: async () => createImmediateTextRun("DONE"),
      }),
    };

    const launches = await Promise.all(
      Array.from({ length: 64 }, (_value, index) =>
        startBackgroundJob({
          abortSignal: new AbortController().signal,
          jobs,
          parentSession,
          prompt: { text: `research ${index}`, type: "user-text" },
          registerCleanup: () => () => undefined,
          sessionKey: `${parentSessionKey}:${index}`,
          subagent,
        })
      )
    );
    await Promise.all([...jobs.values()].map((job) => job.promise));
    const accepted = await startBackgroundJob({
      abortSignal: new AbortController().signal,
      jobs,
      parentSession,
      prompt: { text: "research overflow", type: "user-text" },
      registerCleanup: () => () => undefined,
      sessionKey: `${parentSessionKey}:overflow`,
      subagent,
    });

    expect(jobs.has(launches[0]?.task_id ?? "")).toBe(true);
    expect(jobs.size).toBe(65);
    expect(accepted).toEqual(expect.objectContaining({ status: "running" }));
  });

  it("rejects new background jobs when retained jobs reach the total limit", async () => {
    const jobs = new Map<string, SubagentJob>();
    const parentSession: RuntimeInputSink = {
      emitObserverEvent: () => Promise.resolve(),
      enqueueRuntimeInput: () => undefined,
    };
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => undefined,
        send: async () => createDelayedTextRun("STALE RESULT"),
      }),
    };

    for (let index = 0; index < 256; index += 1) {
      jobs.set(`bg_completed_${index}`, {
        abort: () => undefined,
        cleanup: () => Promise.resolve(),
        id: `bg_completed_${index}`,
        promise: Promise.resolve(),
        sessionKey: `${parentSessionKey}:completed:${index}`,
        settled: true,
        status: "completed",
        subagent: "researcher",
      });
    }

    const rejected = await startBackgroundJob({
      abortSignal: new AbortController().signal,
      jobs,
      parentSession,
      prompt: { text: "research overflow", type: "user-text" },
      registerCleanup: () => () => undefined,
      sessionKey: `${parentSessionKey}:overflow`,
      subagent,
    });

    expect(rejected).toEqual(expect.objectContaining({ status: "cancelled" }));
  });

  it("counts cancelled unsettled jobs toward the active job limit", async () => {
    const jobs = new Map<string, SubagentJob>();
    const parentSession: RuntimeInputSink = {
      emitObserverEvent: () => Promise.resolve(),
      enqueueRuntimeInput: () => undefined,
    };
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => undefined,
        send: async () => createDelayedTextRun("STALE RESULT"),
      }),
    };

    for (let index = 0; index < 64; index += 1) {
      jobs.set(`bg_cancelled_${index}`, {
        abort: () => undefined,
        cleanup: () => Promise.resolve(),
        id: `bg_cancelled_${index}`,
        promise: new Promise(() => undefined),
        sessionKey: `${parentSessionKey}:cancelled:${index}`,
        settled: false,
        status: "cancelled",
        subagent: "researcher",
      });
    }

    const rejected = await startBackgroundJob({
      abortSignal: new AbortController().signal,
      jobs,
      parentSession,
      prompt: { text: "research overflow", type: "user-text" },
      registerCleanup: () => () => undefined,
      sessionKey: `${parentSessionKey}:overflow`,
      subagent,
    });

    expect(rejected).toEqual(expect.objectContaining({ status: "cancelled" }));
  });
});

function createDelayedTextRun(text: string): AgentRun {
  async function* events(): AsyncIterable<AgentEvent> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    yield { text, type: "assistant-text" };
  }

  return {
    events,
  };
}

function createImmediateTextRun(text: string): AgentRun {
  async function* events(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield { text, type: "assistant-text" };
  }

  return {
    events,
  };
}
