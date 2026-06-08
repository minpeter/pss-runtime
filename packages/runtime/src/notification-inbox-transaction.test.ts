import { describe, expect, it } from "vitest";
import { agentNamespace } from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, RunRecord } from "./execution/types";
import { enqueueDurableBackgroundNotification } from "./subagent-background-notification-inbox";
import type { SubagentJob } from "./subagent-types";
import { userText } from "./test-fixtures";

describe("NotificationInbox transaction behavior", () => {
  it("does not create a notification run when transaction enqueue loses a duplicate race", async () => {
    const host = createDuplicateOnEnqueueHost();
    const job = createBackgroundJob(host);
    const input = userText("background task bg_1 is ready");

    await expect(
      enqueueDurableBackgroundNotification({
        input,
        jobs: [job],
        observerEvents: [],
      })
    ).resolves.toBe("queued-only");

    expect(host.createdRuns).toEqual([]);
    expect(host.resumedSessionKeys).toEqual([]);
  });
});

function createDuplicateOnEnqueueHost(): ExecutionHost & {
  readonly createdRuns: readonly RunRecord[];
  readonly resumedSessionKeys: readonly string[];
} {
  const base = createInMemoryExecutionHost();
  const createdRuns: RunRecord[] = [];
  const resumedSessionKeys: string[] = [];
  const duplicateNotifications = {
    claimByIdempotencyKey: base.store.notifications.claimByIdempotencyKey.bind(
      base.store.notifications
    ),
    enqueue: () =>
      Promise.resolve({
        existingNotificationId: "existing-notification",
        ok: false as const,
        reason: "duplicate" as const,
      }),
    getByIdempotencyKey: () => Promise.resolve(null),
    releaseByIdempotencyKey:
      base.store.notifications.releaseByIdempotencyKey.bind(
        base.store.notifications
      ),
  };
  const runStore = {
    claim: base.store.runs.claim.bind(base.store.runs),
    create: (record: RunRecord) => {
      createdRuns.push(record);
      return base.store.runs.create(record);
    },
    get: base.store.runs.get.bind(base.store.runs),
    getByDedupeKey: base.store.runs.getByDedupeKey.bind(base.store.runs),
    listByParentRunId: base.store.runs.listByParentRunId.bind(base.store.runs),
    update: base.store.runs.update.bind(base.store.runs),
  };
  const store = {
    checkpoints: base.store.checkpoints,
    events: base.store.events,
    notifications: duplicateNotifications,
    runs: runStore,
    sessions: base.store.sessions,
    transaction: async <T>(
      fn: Parameters<ExecutionHost["store"]["transaction"]>[0]
    ): Promise<T> =>
      (await fn({
        checkpoints: base.store.checkpoints,
        events: base.store.events,
        notifications: duplicateNotifications,
        runs: runStore,
        sessions: base.store.sessions,
      })) as T,
  } satisfies ExecutionHost["store"];
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      backgroundSubagents: "durable",
    },
    scheduler: {
      enqueueRun: () => Promise.resolve(),
      resumeSession: (sessionKey) => {
        resumedSessionKeys.push(sessionKey);
        return Promise.resolve();
      },
    },
    store,
    createdRuns,
    resumedSessionKeys,
  };
}

function createBackgroundJob(executionHost: ExecutionHost): SubagentJob {
  return {
    abort: () => undefined,
    childRunId: "background:bg_1",
    cleanup: () => Promise.resolve(),
    executionHost,
    id: "bg_1",
    ownerNamespace: agentNamespace("notify-owner"),
    parentSessionKey: "default",
    promise: Promise.resolve(),
    sessionKey: "default:task:bg_1",
    settled: true,
    status: "completed",
    subagent: "researcher",
  };
}
