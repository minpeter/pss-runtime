import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, RunRecord } from "./execution/types";
import { updateBackgroundRunStatus } from "./subagent-background-child-run";
import type { SubagentJob } from "./subagent-types";

describe("background child run status updates", () => {
  it("does not overwrite a durable cancellation observed before completion update", async () => {
    const run = createBackgroundRun("bg_race_cancel");
    const updates: RunRecord[] = [];
    const host = createRaceCancelHost({
      onUpdate: (record) => updates.push(record),
      readRun: () => ({ ...run, status: "cancelled" }),
    });
    const job: SubagentJob = {
      abort: () => undefined,
      childRunId: run.runId,
      cleanup: () => Promise.resolve(),
      executionHost: host,
      id: "bg_race_cancel",
      promise: Promise.resolve(),
      result: {
        eventCount: 1,
        result: "completed",
        run_in_background: false,
        subagent: "researcher",
        text: "done",
      },
      sessionKey: run.sessionKey,
      settled: true,
      status: "completed",
      subagent: "researcher",
    };

    await updateBackgroundRunStatus(job, "completed");

    expect(updates).toEqual([]);
  });

  it("does not publish output from a stale worker after another lease wins", async () => {
    const host = createInMemoryExecutionHost();
    const run = {
      ...createBackgroundRun("bg_stale_lease"),
      lease: {
        attempt: 2,
        leaseId: "new-lease",
        leaseUntilMs: Date.now() + 60_000,
      },
      status: "leased" as const,
    };
    await host.store.runs.create(run);
    const job = createCompletedJob({
      host,
      leaseId: "old-lease",
      run,
    });

    await expect(updateBackgroundRunStatus(job, "completed")).resolves.toBe(
      false
    );
    await expect(host.store.runs.get(run.runId)).resolves.toEqual(run);
  });
});

function createCompletedJob({
  host,
  leaseId,
  run,
}: {
  readonly host: ExecutionHost;
  readonly leaseId: string;
  readonly run: RunRecord;
}): SubagentJob {
  return {
    abort: () => undefined,
    childRunId: run.runId,
    childRunLeaseId: leaseId,
    cleanup: () => Promise.resolve(),
    executionHost: host,
    id: run.publicTaskId ?? "bg_unknown",
    promise: Promise.resolve(),
    result: {
      eventCount: 1,
      result: "completed",
      run_in_background: false,
      subagent: "researcher",
      text: "done",
    },
    sessionKey: run.sessionKey,
    settled: true,
    status: "completed",
    subagent: "researcher",
  };
}

function createBackgroundRun(taskId: string): RunRecord {
  return {
    checkpointVersion: 0,
    kind: "background-subagent",
    parentRunId: "parent",
    publicTaskId: taskId,
    rootRunId: "parent",
    runId: `background:${taskId}`,
    sessionKey: `parent:task:${taskId}`,
    status: "running",
  };
}

function createRaceCancelHost({
  onUpdate,
  readRun,
}: {
  readonly onUpdate: (record: RunRecord) => void;
  readonly readRun: () => RunRecord;
}): ExecutionHost {
  const base = createInMemoryExecutionHost();
  const runs = {
    claim: base.store.runs.claim.bind(base.store.runs),
    create: base.store.runs.create.bind(base.store.runs),
    get: () => Promise.resolve(readRun()),
    getByDedupeKey: base.store.runs.getByDedupeKey.bind(base.store.runs),
    listByParentRunId: base.store.runs.listByParentRunId.bind(base.store.runs),
    update: (record: RunRecord) => {
      onUpdate(record);
      return Promise.resolve(record);
    },
  };
  return {
    ...base,
    store: {
      checkpoints: base.store.checkpoints,
      events: base.store.events,
      notifications: base.store.notifications,
      runs,
      sessions: base.store.sessions,
      transaction: async (fn) =>
        await fn({
          checkpoints: base.store.checkpoints,
          events: base.store.events,
          notifications: base.store.notifications,
          runs,
          sessions: base.store.sessions,
        }),
    },
  };
}
