import { describe, expect, it } from "vitest";
import type { ExecutionHost, TurnStatus } from "../../execution";
import {
  type CloudflareAgentsResumeRun,
  createCloudflareAgentsExecutionHost,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import {
  createFakeCloudflareAgent,
  type FakeCloudflareAgent,
  runWithText,
} from "./test-support";

describe("Cloudflare Agents fiber retries", () => {
  it("reschedules retryable notifications when resume cannot claim a run", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));

    await seedRetryableNotification(host, "background:bg_not_claimable");
    await host.scheduler.enqueueRun("background:bg_not_claimable");

    await expectRetryScheduled({
      cloudflareAgent,
      host,
      runId: "background:bg_not_claimable",
    });
  });

  it("does not reschedule completed notifications when resume cannot claim a run", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));
    const runId = "background:bg_completed_not_claimable";

    await seedRetryableNotification(host, runId, "completed");

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "PSS Runtime fiber interrupted: not-claimable"
    );
    expect(cloudflareAgent.scheduled).toEqual([]);
    await expectCompletedNotification(host, runId);
  });

  it("reschedules retryable notifications when draining hits the event budget", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(
      cloudflareAgent,
      (payload) => Promise.resolve(runWithText(payload.runId)),
      { maxEvents: 0 }
    );

    await seedRetryableNotification(host, "background:bg_event_budget");
    await host.scheduler.enqueueRun("background:bg_event_budget");

    await expectRetryScheduled({
      cloudflareAgent,
      host,
      runId: "background:bg_event_budget",
    });
  });

  it("reschedules notifications completed before drain when draining hits the event budget", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    let host: ExecutionHost;
    host = createRetryHost(
      cloudflareAgent,
      async (payload) => {
        const run = await host.store.turns.get(payload.runId);
        if (!run) {
          throw new Error(`missing run: ${payload.runId}`);
        }
        const { lease: _lease, ...runWithoutLease } = run;
        await host.store.turns.update({
          ...runWithoutLease,
          status: "completed",
        });
        return runWithText(payload.runId);
      },
      { maxEvents: 0 }
    );

    await seedRetryableNotification(
      host,
      "background:bg_completed_event_budget"
    );
    await host.scheduler.enqueueRun("background:bg_completed_event_budget");

    await expectRetryScheduled({
      cloudflareAgent,
      host,
      runId: "background:bg_completed_event_budget",
    });
  });

  it("uses a fresh fiber idempotency key when a scheduled retry starts", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(
      cloudflareAgent,
      (payload) => Promise.resolve(runWithText(payload.runId)),
      { maxEvents: 0 }
    );

    await seedRetryableNotification(host, "background:bg_retry_key");
    await host.scheduler.enqueueRun("background:bg_retry_key");

    const firstFiberKey = cloudflareAgent.started[0]?.idempotencyKey;
    await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: cloudflareAgent.scheduled[0]?.payload,
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
    });

    expect(firstFiberKey).toBe(
      "pss-runtime:run:8:tenant-a:23:background:bg_retry_key"
    );
    expect(cloudflareAgent.started[1]?.idempotencyKey).toBe(
      "pss-runtime:run:8:tenant-a:23:background:bg_retry_key:attempt:1"
    );
  });

  it("does not requeue notifications before retry scheduling succeeds", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    cloudflareAgent.schedule = () =>
      Promise.reject(new Error("schedule failed"));
    let host: ExecutionHost;
    host = createRetryHost(
      cloudflareAgent,
      async (payload) => {
        const run = await host.store.turns.get(payload.runId);
        if (!run) {
          throw new Error(`missing run: ${payload.runId}`);
        }
        const { lease: _lease, ...runWithoutLease } = run;
        await host.store.turns.update({
          ...runWithoutLease,
          status: "completed",
        });
        return runWithText(payload.runId);
      },
      { maxEvents: 0 }
    );
    const runId = "background:bg_schedule_failure";

    await seedRetryableNotification(host, runId);

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "schedule failed"
    );
    await expectCompletedNotification(host, runId);
  });

  it("reschedules retryable notifications when resume work throws", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(cloudflareAgent, async () => {
      await Promise.resolve();
      throw new Error("resume failed");
    });

    await seedRetryableNotification(host, "background:bg_throw");
    await host.scheduler.enqueueRun("background:bg_throw");

    await expectRetryScheduled({
      cloudflareAgent,
      host,
      runId: "background:bg_throw",
    });
  });
});

function createRetryHost(
  cloudflareAgent: FakeCloudflareAgent,
  resume: CloudflareAgentsResumeRun,
  drain?: { readonly maxEvents?: number }
): ExecutionHost {
  return createCloudflareAgentsExecutionHost({
    cloudflareAgent,
    drain,
    durableObjectContext: cloudflareAgent.durableObjectContext,
    prefix: "tenant-a",
    resume,
  });
}

async function seedRetryableNotification(
  host: ExecutionHost,
  runId: string,
  status: TurnStatus = "leased"
): Promise<void> {
  const dedupeKey = dedupeKeyFor(runId);
  await host.store.turns.create({
    checkpointVersion: 0,
    dedupeKey,
    kind: "notification",
    lease: {
      attempt: 1,
      leaseId: `lease:${runId}`,
      leaseUntilMs: Date.now() + 60_000,
    },
    rootRunId: runId,
    runId,
    status,
    threadKey: "thread-a",
  });
  await host.store.notifications.enqueue({
    idempotencyKey: dedupeKey,
    input: { text: "retry", type: "user-input" },
    notificationId: `notification:${runId}`,
    runId,
    status: "acked",
    threadKey: "thread-a",
  });
}

async function expectRetryScheduled({
  cloudflareAgent,
  host,
  runId,
}: {
  readonly cloudflareAgent: FakeCloudflareAgent;
  readonly host: ExecutionHost;
  readonly runId: string;
}): Promise<void> {
  expect(cloudflareAgent.scheduled).toEqual([
    {
      callback: "resumePssRuntimeFiber",
      idempotent: true,
      payload: {
        attempt: 1,
        kind: "run",
        prefix: "tenant-a",
        runId,
        version: 1,
      },
      when: 1,
    },
  ]);
  const run = await host.store.turns.get(runId);
  const notification = await host.store.notifications.getByIdempotencyKey(
    dedupeKeyFor(runId)
  );
  expect(run).toMatchObject({ runId, status: "queued" });
  expect(run?.lease).toBeUndefined();
  expect(notification).toMatchObject({ runId, status: "pending" });
}

async function expectCompletedNotification(
  host: ExecutionHost,
  runId: string
): Promise<void> {
  const run = await host.store.turns.get(runId);
  const notification = await host.store.notifications.getByIdempotencyKey(
    dedupeKeyFor(runId)
  );
  expect(run).toMatchObject({ runId, status: "completed" });
  expect(notification).toMatchObject({ runId, status: "acked" });
}

function dedupeKeyFor(runId: string): string {
  return `dedupe:${runId}`;
}
