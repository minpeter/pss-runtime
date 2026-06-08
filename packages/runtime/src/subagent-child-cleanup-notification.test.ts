import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, RunRecord } from "./execution/types";
import type { UserInput } from "./session/input";
import type { AgentRun } from "./session/run";
import { updateBackgroundRunStatus } from "./subagent-background-child-run";
import {
  notifyBackgroundCompletion,
  registerBackgroundJobGroup,
} from "./subagent-background-notify";
import type {
  RuntimeInputSink,
  SubagentJob,
  SubagentJobGroup,
} from "./subagent-types";

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

  it("notifies completed siblings when a cancelled sibling is stale", async () => {
    const host = createDurableHost();
    await host.store.runs.create(
      createChildRun({
        kind: "background-subagent",
        publicTaskId: "bg_cancelled",
        runId: "background:bg_cancelled",
        status: "cancelled",
      })
    );
    await host.store.runs.create(
      createChildRun({
        kind: "background-subagent",
        publicTaskId: "bg_done",
        runId: "background:bg_done",
        status: "completed",
      })
    );
    const inlineNotifications: UserInput[] = [];
    const groupId = "group-cleanup";
    const cancelledJob = createBackgroundJob(host, {
      childRunId: "background:bg_cancelled",
      groupId,
      id: "bg_cancelled",
      status: "cancelled",
    });
    const completedJob = createBackgroundJob(host, {
      childRunId: "background:bg_done",
      groupId,
      id: "bg_done",
      status: "completed",
    });
    const jobs = new Map([
      [cancelledJob.id, cancelledJob],
      [completedJob.id, completedJob],
    ]);
    const groups = new Map<string, SubagentJobGroup>();
    registerBackgroundJobGroup({ groupId, groups, job: cancelledJob });
    registerBackgroundJobGroup({ groupId, groups, job: completedJob });

    groups.get(groupId)?.failedNotifiedJobIds.add(cancelledJob.id);
    await notifyBackgroundCompletion({
      endEvent: {
        eventCount: 1,
        status: "completed",
        subagent: "researcher",
        task_id: completedJob.id,
        type: "subagent-job-end",
      },
      groups,
      job: completedJob,
      jobs,
      parentSession: createParentSession(inlineNotifications),
    });

    await expect(
      host.store.notifications.getByIdempotencyKey(
        "background-complete:default:bg_done"
      )
    ).resolves.toMatchObject({
      sessionKey: "default",
      status: "pending",
    });
    await expect(
      host.store.notifications.getByIdempotencyKey(
        "background-complete:default:bg_cancelled,bg_done"
      )
    ).resolves.toBeNull();
    expect(host.resumedSessionKeys).toEqual(["default"]);
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

function createBackgroundJob(
  host: ExecutionHost,
  options: {
    readonly childRunId?: string;
    readonly groupId?: string;
    readonly id?: string;
    readonly status?: SubagentJob["status"];
  } = {}
): SubagentJob {
  const id = options.id ?? "bg_1";
  const childRunId = options.childRunId ?? "background:bg_1";
  return {
    abort: () => undefined,
    childRunId,
    cleanup: () => Promise.resolve(),
    executionHost: host,
    groupId: options.groupId,
    id,
    ownerNamespace: "owner",
    parentSessionKey: "default",
    promise: Promise.resolve(),
    sessionKey: `${childRunId}:session`,
    settled: true,
    status: options.status ?? "completed",
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
