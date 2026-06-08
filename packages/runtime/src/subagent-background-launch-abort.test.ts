import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, RunRecord } from "./execution/types";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";
import { startBackgroundJob } from "./subagent-jobs";
import type { RuntimeInputSink, Subagent, SubagentJob } from "./subagent-types";
import { createDeferred } from "./test-fixtures";

describe("durable background launch aborts", () => {
  it("aborts when the signal fires while creating the durable child run", async () => {
    const baseHost = createInMemoryExecutionHost();
    const createStarted = createDeferred();
    const createCanFinish = createDeferred();
    const host = createDelayedRunCreateHost({
      baseHost,
      createCanFinish,
      createStarted,
    });
    const jobs = new Map<string, SubagentJob>();
    const abortController = new AbortController();
    let childSends = 0;
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => undefined,
        send: () => {
          childSends += 1;
          return Promise.resolve(emptyRun());
        },
      }),
    };

    const launchPromise = startBackgroundJob({
      abortSignal: abortController.signal,
      delegateToolCallId: "call_abort_during_create",
      executionHost: host,
      jobs,
      parentSession: parentSession(),
      parentSessionKey: "parent",
      prompt: { text: "research", type: "user-text" },
      registerCleanup: () => () => undefined,
      sessionKey:
        "parent:agent:qa:session:parent:generation:0:parent:subagent:researcher",
      subagent,
    });

    await createStarted.promise;
    abortController.abort();
    createCanFinish.resolve();

    await expect(launchPromise).resolves.toMatchObject({
      status: "cancelled",
      subagent: "researcher",
    });
    expect(childSends).toBe(0);
    expect(jobs.size).toBe(0);
    const launch = await launchPromise;
    await expect(
      host.store.runs.get(`background:${launch.task_id}`)
    ).resolves.toMatchObject({ status: "cancelled" });
  });
});

function parentSession(): RuntimeInputSink {
  return {
    emitObserverEvent: () => Promise.resolve(),
    enqueueRuntimeInput: () => undefined,
    notify: () => Promise.resolve(emptyRun()),
  };
}

function createDelayedRunCreateHost({
  baseHost,
  createCanFinish,
  createStarted,
}: {
  readonly baseHost: ExecutionHost;
  readonly createCanFinish: ReturnType<typeof createDeferred>;
  readonly createStarted: ReturnType<typeof createDeferred>;
}): ExecutionHost {
  return {
    ...baseHost,
    store: {
      checkpoints: baseHost.store.checkpoints,
      events: baseHost.store.events,
      notifications: baseHost.store.notifications,
      runs: {
        claim: baseHost.store.runs.claim.bind(baseHost.store.runs),
        create: async (record: RunRecord) => {
          createStarted.resolve();
          await createCanFinish.promise;
          return await baseHost.store.runs.create(record);
        },
        get: baseHost.store.runs.get.bind(baseHost.store.runs),
        getByDedupeKey: baseHost.store.runs.getByDedupeKey.bind(
          baseHost.store.runs
        ),
        listByParentRunId: baseHost.store.runs.listByParentRunId.bind(
          baseHost.store.runs
        ),
        update: baseHost.store.runs.update.bind(baseHost.store.runs),
      },
      sessions: baseHost.store.sessions,
      transaction: (fn) =>
        baseHost.store.transaction((tx) =>
          fn({
            checkpoints: tx.checkpoints,
            events: tx.events,
            notifications: tx.notifications,
            runs: {
              claim: tx.runs.claim.bind(tx.runs),
              create: async (record: RunRecord) => {
                createStarted.resolve();
                await createCanFinish.promise;
                return await tx.runs.create(record);
              },
              get: tx.runs.get.bind(tx.runs),
              getByDedupeKey: tx.runs.getByDedupeKey.bind(tx.runs),
              listByParentRunId: tx.runs.listByParentRunId.bind(tx.runs),
              update: tx.runs.update.bind(tx.runs),
            },
            sessions: tx.sessions,
          })
        ),
    },
  };
}

function emptyRun(): AgentRun {
  const events = () => ({
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () =>
      Promise.resolve({
        done: true as const,
        value: undefined as never as AgentEvent,
      }),
  });
  return { events };
}
