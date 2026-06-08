import { describe, expect, it } from "vitest";
import { agentNamespace } from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, NotificationRecord } from "./execution/types";
import { enqueueDurableBackgroundNotification } from "./subagent-background-notification-inbox";
import type { SubagentJob } from "./subagent-types";
import { userText } from "./test-fixtures";

describe("NotificationInbox", () => {
  it("dedupes duplicate completion notification by key", async () => {
    const host = createInMemoryExecutionHost();
    const record = createNotificationRecord();

    await expect(host.store.notifications.enqueue(record)).resolves.toEqual({
      ok: true,
    });

    const firstClaim = await host.store.notifications.claimByIdempotencyKey(
      record.idempotencyKey
    );
    expect(firstClaim).toEqual({
      ok: true,
      record: expect.objectContaining({
        idempotencyKey: record.idempotencyKey,
        status: "pending",
      }),
    });
    await expect(
      host.store.notifications.getByIdempotencyKey(record.idempotencyKey)
    ).resolves.toEqual(expect.objectContaining({ status: "acked" }));

    const duplicateClaim = await host.store.notifications.claimByIdempotencyKey(
      record.idempotencyKey
    );
    expect(duplicateClaim).toEqual({
      ok: false,
      reason: "already-claimed",
      record: expect.objectContaining({ status: "acked" }),
    });
  });

  it("does not enqueue in-process background completion notifications", async () => {
    const host = createResumeTrackingHost();
    const job = createBackgroundJob(host);
    const input = userText("background task bg_1 is ready");
    const observerEvents = [
      {
        eventCount: 1,
        status: "completed",
        subagent: "researcher",
        task_id: job.id,
        type: "subagent-job-end",
      },
    ] as const;

    await expect(
      enqueueDurableBackgroundNotification({
        input,
        jobs: [job],
        observerEvents,
      })
    ).resolves.toBe("inline");
    await expect(
      host.store.notifications.getByIdempotencyKey(
        "background-complete:default:bg_1"
      )
    ).resolves.toBeNull();
    await expect(
      enqueueDurableBackgroundNotification({
        input,
        jobs: [job],
        observerEvents,
      })
    ).resolves.toBe("inline");
    expect(host.resumedSessionKeys).toEqual([]);
  });

  it("retries durable session resume for an existing pending notification", async () => {
    const host = createFlakyDurableResumeHost();
    const job = createBackgroundJob(host);
    const input = userText("background task bg_1 is ready");
    const observerEvents = [
      {
        eventCount: 1,
        status: "completed",
        subagent: "researcher",
        task_id: job.id,
        type: "subagent-job-end",
      },
    ] as const;

    await expect(
      enqueueDurableBackgroundNotification({
        input,
        jobs: [job],
        observerEvents,
      })
    ).rejects.toThrow("resume failed");
    await expect(
      host.store.notifications.getByIdempotencyKey(
        "background-complete:default:bg_1"
      )
    ).resolves.toEqual(expect.objectContaining({ status: "pending" }));

    await expect(
      enqueueDurableBackgroundNotification({
        input,
        jobs: [job],
        observerEvents,
      })
    ).resolves.toBe("queued-only");
    expect(host.resumedSessionKeys).toEqual(["default", "default"]);
  });
});

function createNotificationRecord(): NotificationRecord {
  return {
    idempotencyKey: "background-complete:bg_1",
    input: userText("background task bg_1 is ready"),
    notificationId: "notification-1",
    ownerNamespace: agentNamespace("notify-owner"),
    runId: "notification-run-1",
    sessionKey: "default",
    status: "pending",
  };
}

function createResumeTrackingHost(): ExecutionHost & {
  readonly resumedSessionKeys: readonly string[];
} {
  const base = createInMemoryExecutionHost();
  const resumedSessionKeys: string[] = [];
  return {
    ...base,
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

function createFlakyDurableResumeHost(): ExecutionHost & {
  readonly resumedSessionKeys: readonly string[];
} {
  const base = createInMemoryExecutionHost();
  const resumedSessionKeys: string[] = [];
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
        return resumedSessionKeys.length === 1
          ? Promise.reject(new Error("resume failed"))
          : Promise.resolve();
      },
    },
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
