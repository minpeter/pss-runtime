import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, RunRecord } from "./execution/types";
import type { UserInput } from "./session/input";
import type { AgentRun } from "./session/run";
import { updateBackgroundRunStatus } from "./subagent-background-child-run";
import { notifyBackgroundCompletion } from "./subagent-background-notify";
import type { RuntimeInputSink, SubagentJob } from "./subagent-types";

describe("durable subagent child cleanup notification", () => {
  it("stale cancelled child completion cannot notify parent", async () => {
    const host = createDurableHost();
    await host.store.runs.create(
      createChildRun({
        kind: "background-subagent",
        publicTaskId: "bg_1",
        runId: "background:bg_1",
        status: "cancelled",
      })
    );
    const inlineNotifications: UserInput[] = [];
    const job = createBackgroundJob(host);
    const jobs = new Map([[job.id, job]]);

    await updateBackgroundRunStatus(job, "completed");
    await notifyBackgroundCompletion({
      endEvent: {
        eventCount: 1,
        status: "completed",
        subagent: "researcher",
        task_id: job.id,
        type: "subagent-job-end",
      },
      groups: new Map(),
      job,
      jobs,
      parentSession: createParentSession(inlineNotifications),
    });

    await expect(host.store.runs.get("background:bg_1")).resolves.toMatchObject(
      {
        status: "cancelled",
      }
    );
    await expect(
      host.store.notifications.getByIdempotencyKey(
        "background-complete:default:bg_1"
      )
    ).resolves.toBeNull();
    expect(host.resumedSessionKeys).toEqual([]);
    expect(inlineNotifications).toEqual([]);
  });
});

interface DurableTestHost extends ExecutionHost {
  readonly resumedSessionKeys: readonly string[];
}

function createDurableHost(): DurableTestHost {
  const base = createInMemoryExecutionHost();
  const resumedSessionKeys: string[] = [];
  return {
    ...base,
    capabilities: {
      backgroundSubagents: "durable",
    },
    scheduler: {
      enqueueRun: () => Promise.resolve(),
      resumeSession: (sessionKey) => {
        resumedSessionKeys.push(sessionKey);
        return Promise.resolve();
      },
    },
    resumedSessionKeys,
  };
}

function createChildRun(
  input: Pick<RunRecord, "kind" | "runId" | "status"> &
    Pick<Partial<RunRecord>, "publicTaskId">
): RunRecord {
  return {
    checkpointVersion: 0,
    kind: input.kind,
    publicTaskId: input.publicTaskId,
    rootRunId: "background-cleanup",
    runId: input.runId,
    sessionKey: `${input.runId}:session`,
    status: input.status,
  };
}

function createBackgroundJob(host: ExecutionHost): SubagentJob {
  return {
    abort: () => undefined,
    childRunId: "background:bg_1",
    cleanup: () => Promise.resolve(),
    executionHost: host,
    id: "bg_1",
    parentSessionKey: "default",
    promise: Promise.resolve(),
    sessionKey: "background:bg_1:session",
    settled: true,
    status: "completed",
    subagent: "researcher",
  };
}

function createParentSession(notifications: UserInput[]): RuntimeInputSink {
  return {
    emitObserverEvent: () => Promise.resolve(),
    enqueueRuntimeInput: () => undefined,
    notify: (input) => {
      notifications.push(input);
      return Promise.resolve(createEmptyRun());
    },
  };
}

function createEmptyRun(): AgentRun {
  return {
    events: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve({
              done: true,
              value: undefined,
            }),
        };
      },
    }),
  };
}
