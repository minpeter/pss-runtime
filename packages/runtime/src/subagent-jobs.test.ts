import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";
import { startBackgroundJob } from "./subagent-jobs";
import type { RuntimeInputSink, Subagent, SubagentJob } from "./subagent-types";

const parentSessionKey = "parent:default:subagent:researcher";

describe("subagent background jobs", () => {
  it("does not enqueue completion reminders for pruned active jobs", async () => {
    const jobs = new Map<string, SubagentJob>();
    const runtimeInputs: string[] = [];
    let interruptCount = 0;
    const parentSession: RuntimeInputSink = {
      emitObserverEvent: () => undefined,
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

    const launches = Array.from({ length: 65 }, (_value, index) =>
      startBackgroundJob({
        abortSignal: new AbortController().signal,
        jobs,
        parentSession,
        prompt: { text: `research ${index}`, type: "user-text" },
        registerCleanup: () => undefined,
        sessionKey: `${parentSessionKey}:${index}`,
        subagent,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interruptCount).toBe(1);
    expect(jobs.has(launches[0]?.task_id ?? "")).toBe(false);
    expect(launches.at(-1)).toEqual(
      expect.objectContaining({ status: "running" })
    );
    expect(runtimeInputs.join("\n")).not.toContain(launches[0]?.task_id);
  });

  it("starts a new job when pruned active job cleanup fails", async () => {
    const jobs = new Map<string, SubagentJob>();
    const parentSession: RuntimeInputSink = {
      emitObserverEvent: () => undefined,
      enqueueRuntimeInput: () => undefined,
    };
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: () => Promise.reject(new Error("cleanup failed")),
        interrupt: () => undefined,
        send: async () => createDelayedTextRun("STALE RESULT"),
      }),
    };

    const launches = Array.from({ length: 65 }, (_value, index) =>
      startBackgroundJob({
        abortSignal: new AbortController().signal,
        jobs,
        parentSession,
        prompt: { text: `research ${index}`, type: "user-text" },
        registerCleanup: () => undefined,
        sessionKey: `${parentSessionKey}:${index}`,
        subagent,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(jobs.has(launches[0]?.task_id ?? "")).toBe(false);
    expect(jobs.size).toBe(64);
    expect(launches.at(-1)).toEqual(
      expect.objectContaining({ status: "running" })
    );
  });

  it("does not prune completed jobs before background_output retrieves them", async () => {
    const jobs = new Map<string, SubagentJob>();
    const parentSession: RuntimeInputSink = {
      emitObserverEvent: () => undefined,
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

    const launches = Array.from({ length: 64 }, (_value, index) =>
      startBackgroundJob({
        abortSignal: new AbortController().signal,
        jobs,
        parentSession,
        prompt: { text: `research ${index}`, type: "user-text" },
        registerCleanup: () => undefined,
        sessionKey: `${parentSessionKey}:${index}`,
        subagent,
      })
    );
    await Promise.all([...jobs.values()].map((job) => job.promise));
    const rejected = startBackgroundJob({
      abortSignal: new AbortController().signal,
      jobs,
      parentSession,
      prompt: { text: "research overflow", type: "user-text" },
      registerCleanup: () => undefined,
      sessionKey: `${parentSessionKey}:overflow`,
      subagent,
    });

    expect(jobs.has(launches[0]?.task_id ?? "")).toBe(true);
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
