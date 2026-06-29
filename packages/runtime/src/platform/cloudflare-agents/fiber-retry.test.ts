import { describe, expect, it } from "vitest";
import type { ExecutionHost, TurnStatus } from "../../execution";
import {
  type CloudflareAgentsResumeRun,
  createCloudflareAgentsExecutionHost,
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

function dedupeKeyFor(runId: string): string {
  return `dedupe:${runId}`;
}
