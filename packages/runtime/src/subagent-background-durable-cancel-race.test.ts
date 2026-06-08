import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost } from "./execution/types";
import { toolExecutionOptions } from "./llm-test-utils";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";
import { runBackgroundJob } from "./subagent-background-runner";
import { createBackgroundCancelTool } from "./subagent-job-cancel";
import { startBackgroundJob } from "./subagent-jobs";
import type { RuntimeInputSink, Subagent, SubagentJob } from "./subagent-types";
import { createDeferred } from "./test-fixtures";

describe("durable background cancellation races", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("interrupts a live child run when another process cancels its durable task", async () => {
    const host = createDurableHost();
    const jobs = new Map<string, SubagentJob>();
    const childStarted = createDeferred();
    const childInterrupted = createDeferred();
    const notifications: string[] = [];
    let interrupted = false;
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => {
          interrupted = true;
          childInterrupted.resolve();
        },
        send: () => {
          childStarted.resolve();
          return Promise.resolve(interruptibleRun(childInterrupted));
        },
      }),
    };
    const launch = await startBackgroundJob({
      abortSignal: new AbortController().signal,
      delegateToolCallId: "call_cross_process_cancel",
      executionHost: host,
      jobs,
      parentSession: parentSession(notifications),
      parentSessionKey: "parent",
      prompt: { text: "research", type: "user-text" },
      registerCleanup: () => () => undefined,
      sessionKey:
        "parent:agent:qa:session:parent:generation:0:parent:subagent:researcher",
      subagent,
    });
    const job = jobs.get(launch.task_id);
    if (!job) {
      throw new Error("Expected background job to be registered.");
    }

    const runId = `background:${launch.task_id}`;
    const claim = await host.store.runs.claim(runId, {
      attempt: 1,
      leaseId: "lease-cross-process-cancel",
      leaseMs: 300_000,
      nowMs: Date.now(),
    });
    if (!claim.ok) {
      throw new Error(
        `Expected background run to be claimable: ${claim.reason}`
      );
    }

    const childSession = subagent.session(claim.record.sessionKey);
    const runningJob: SubagentJob = {
      abort: () => childSession.interrupt(),
      childRunId: claim.record.runId,
      childRunLeaseId: claim.record.lease?.leaseId,
      cleanup: () => Promise.resolve(),
      dedupeKey: claim.record.dedupeKey,
      executionHost: host,
      id: launch.task_id,
      parentRunId: claim.record.parentRunId,
      parentSessionKey: "parent",
      promise: Promise.resolve(),
      sessionKey: claim.record.sessionKey,
      settled: false,
      status: "running",
      subagent: "researcher",
    };
    const runningJobs = new Map([[runningJob.id, runningJob]]);
    vi.useFakeTimers();
    runningJob.promise = runBackgroundJob({
      childSession,
      groups: new Map(),
      job: runningJob,
      jobs: runningJobs,
      parentSession: parentSession(notifications),
      prompt: { text: "research", type: "user-text" },
    });

    await childStarted.promise;
    await createBackgroundCancelTool(new Map(), host).execute?.(
      { task_id: launch.task_id },
      { ...toolExecutionOptions(), context: {} }
    );

    await vi.advanceTimersByTimeAsync(250);
    await runningJob.promise;
    expect(interrupted).toBe(true);
    expect(runningJob.status).toBe("cancelled");
    expect(notifications).toEqual([]);
    await expect(
      host.store.runs.get(`background:${launch.task_id}`)
    ).resolves.toMatchObject({ status: "cancelled" });
  });
});

function createDurableHost(): ExecutionHost {
  const base = createInMemoryExecutionHost();
  return {
    ...base,
    capabilities: { backgroundSubagents: "durable" },
  };
}

function parentSession(notifications: string[]): RuntimeInputSink {
  return {
    emitObserverEvent: () => Promise.resolve(),
    enqueueRuntimeInput: () => undefined,
    notify: (input) => {
      if (input.type === "user-text") {
        notifications.push("notified");
      }
      return Promise.resolve(emptyRun());
    },
  };
}

function interruptibleRun(childInterrupted: ReturnType<typeof createDeferred>) {
  return {
    events: () => ({
      async *[Symbol.asyncIterator]() {
        await childInterrupted.promise;
        yield { type: "turn-abort" } satisfies AgentEvent;
      },
    }),
  } satisfies AgentRun;
}

function emptyRun(): AgentRun {
  return {
    events: () => {
      const iterator: AsyncIterator<AgentEvent> & AsyncIterable<AgentEvent> = {
        next: () =>
          Promise.resolve({
            done: true as const,
            value: undefined as never as AgentEvent,
          }),
        [Symbol.asyncIterator]: () => iterator,
      };
      return iterator;
    },
  };
}
