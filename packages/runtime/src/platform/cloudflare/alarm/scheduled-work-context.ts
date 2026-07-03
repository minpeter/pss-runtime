import type { TurnRecord, TurnStatus } from "../../../execution";
import { createCloudflareDurableObjectHost } from "../host/durable-object-host";
import type { CloudflareScheduledThreadPrompt } from "../host/scheduled-work-queue";
import type { CloudflareDurableObjectStorage } from "../storage/durable-object/durable-object-storage";
import type { CloudflareAlarmRunContext } from "./run-context";

export async function scheduledRunContext(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<CloudflareAlarmRunContext> {
  const run = await createCloudflareDurableObjectHost({
    prefix,
    storage,
  }).store.turns.get(runId);
  return {
    runId,
    threadKey: run?.threadKey ?? "",
    source: "scheduled-run",
  };
}

export async function scheduledThreadPromptContext(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<CloudflareAlarmRunContext | undefined> {
  const runId = await scheduledThreadPromptRunId(storage, prefix, prompt);
  if (!runId) {
    return;
  }

  return {
    idempotencyKey: prompt.idempotencyKey,
    notificationId: prompt.notificationId,
    runId,
    threadKey: prompt.threadKey,
    source: "thread-prompt",
  };
}

export async function shouldRetryScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  const run = await createCloudflareDurableObjectHost({
    prefix,
    storage,
  }).store.turns.get(runId);
  return run?.kind === "notification" && isRetryableRunStatus(run.status);
}

export async function shouldRetryNotClaimableScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  const run = await createCloudflareDurableObjectHost({
    prefix,
    storage,
  }).store.turns.get(runId);
  return (
    run?.kind === "notification" &&
    isRetryableRunStatus(run.status) &&
    !hasActiveLease(run)
  );
}

export async function shouldRetryScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<boolean> {
  const runId = await scheduledThreadPromptRunId(storage, prefix, prompt);
  return runId ? await shouldRetryScheduledRun(storage, prefix, runId) : false;
}

export function threadPromptId(
  prompt: CloudflareScheduledThreadPrompt
): string {
  return prompt.idempotencyKey ?? prompt.runId ?? "<missing-run-id>";
}

export async function prepareScheduledNotificationRetry(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  const host = createCloudflareDurableObjectHost({ prefix, storage });
  let prepared = false;
  await host.store.transaction(async (tx) => {
    const run = await tx.turns.get(runId);
    if (run?.kind !== "notification" || !run.dedupeKey) {
      return;
    }

    await tx.turns.update(retryableNotificationRun(run));
    await tx.notifications.releaseByIdempotencyKey(run.dedupeKey);
    prepared = true;
  });
  return prepared;
}

async function scheduledThreadPromptRunId(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<string | undefined> {
  if (prompt.runId) {
    return prompt.runId;
  }
  if (!prompt.idempotencyKey) {
    return;
  }

  const notification = await createCloudflareDurableObjectHost({
    prefix,
    storage,
  }).store.notifications.getByIdempotencyKey(prompt.idempotencyKey);
  return notification?.runId;
}

function isRetryableRunStatus(status: TurnStatus | undefined): boolean {
  return (
    status === "leased" ||
    status === "queued" ||
    status === "running" ||
    status === "suspended"
  );
}

function hasActiveLease(run: TurnRecord): boolean {
  return run.lease !== undefined && run.lease.leaseUntilMs > Date.now();
}

function retryableNotificationRun(run: TurnRecord): TurnRecord {
  const { lease: _lease, ...runWithoutLease } = run;
  return { ...runWithoutLease, status: "queued" };
}
