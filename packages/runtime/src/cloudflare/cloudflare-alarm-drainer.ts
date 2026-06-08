import type { RunStatus } from "../execution";
import type { AgentEvent, AgentRun } from "../index";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareSessionPrompt,
  type CloudflareDurableObjectStorage,
  type CloudflareScheduledSessionPrompt,
  createCloudflareDurableObjectHost,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
  rescheduleCloudflareAlarm,
} from "./cloudflare-host";

export interface CloudflareAlarmDrainSummary {
  readonly consumedSessionPrompts: readonly string[];
  readonly events: readonly AgentEvent[];
  readonly failedRuns: readonly FailedScheduledWork[];
  readonly failedSessionPrompts: readonly FailedScheduledWork[];
  readonly markers: readonly string[];
  readonly resumedRuns: readonly string[];
}

export interface CloudflareAlarmAgent {
  resume(runId: string): Promise<AgentRun | null>;
}

export interface CloudflareAgentRunDrainOptions {
  readonly onEvent?: (event: AgentEvent) => Promise<void> | void;
}

interface FailedScheduledWork {
  readonly error: string;
  readonly id: string;
}

export async function drainCloudflareAlarm({
  agent,
  prefix,
  storage,
}: {
  readonly agent: CloudflareAlarmAgent;
  readonly prefix: string;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<CloudflareAlarmDrainSummary> {
  const events: AgentEvent[] = [];
  const failedRuns: FailedScheduledWork[] = [];
  const failedSessionPrompts: FailedScheduledWork[] = [];
  const resumedRuns: string[] = [];
  const consumedSessionPrompts: string[] = [];

  for (const runId of await listScheduledCloudflareRuns(storage, { prefix })) {
    await resumeScheduledRun({
      agent,
      events,
      failedRuns,
      prefix,
      resumedRuns,
      runId,
      storage,
    });
  }

  for (const prompt of await listScheduledCloudflareSessionPrompts(storage, {
    prefix,
  })) {
    await resumeScheduledSessionPrompt({
      agent,
      consumedSessionPrompts,
      events,
      failedSessionPrompts,
      prefix,
      prompt,
      storage,
    });
  }

  if (failedRuns.length > 0 || failedSessionPrompts.length > 0) {
    await rescheduleCloudflareAlarm(storage, { runAfterMs: 1000 });
  }

  return {
    consumedSessionPrompts,
    events,
    failedRuns,
    failedSessionPrompts,
    markers: ["alarm:resume", "resume:session-prompt"],
    resumedRuns,
  };
}

export async function drainAgentRun(
  run: AgentRun,
  options: CloudflareAgentRunDrainOptions = {}
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
    await options.onEvent?.(event);
  }
  return events;
}

async function resumeScheduledRun({
  agent,
  events,
  failedRuns,
  prefix,
  resumedRuns,
  runId,
  storage,
}: {
  readonly agent: CloudflareAlarmAgent;
  readonly events: AgentEvent[];
  readonly failedRuns: FailedScheduledWork[];
  readonly prefix: string;
  readonly resumedRuns: string[];
  readonly runId: string;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  try {
    const run = await agent.resume(runId);
    if (!run) {
      if (await shouldRetryScheduledRun(storage, prefix, runId)) {
        failedRuns.push({
          error: "Run was not claimable during this alarm.",
          id: runId,
        });
        return;
      }
      await ackScheduledCloudflareRun(storage, runId, { prefix });
      return;
    }
    resumedRuns.push(runId);
    events.push(...(await drainAgentRun(run)));
    await ackScheduledCloudflareRun(storage, runId, { prefix });
  } catch (error) {
    failedRuns.push({ error: describeError(error), id: runId });
  }
}

async function resumeScheduledSessionPrompt({
  agent,
  consumedSessionPrompts,
  events,
  failedSessionPrompts,
  prefix,
  prompt,
  storage,
}: {
  readonly agent: CloudflareAlarmAgent;
  readonly consumedSessionPrompts: string[];
  readonly events: AgentEvent[];
  readonly failedSessionPrompts: FailedScheduledWork[];
  readonly prefix: string;
  readonly prompt: CloudflareScheduledSessionPrompt;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  try {
    const runId = await scheduledSessionPromptRunId(storage, prefix, prompt);
    if (!runId) {
      failedSessionPrompts.push({
        error: "Session prompt did not include or resolve to a run id.",
        id: sessionPromptId(prompt),
      });
      return;
    }

    const run = await agent.resume(runId);
    if (!run) {
      if (await shouldRetryScheduledSessionPrompt(storage, prefix, prompt)) {
        failedSessionPrompts.push({
          error: "Session prompt was not claimable during this alarm.",
          id: sessionPromptId(prompt),
        });
        return;
      }
      await ackScheduledCloudflareSessionPrompt(storage, prompt, { prefix });
      return;
    }
    consumedSessionPrompts.push(sessionPromptId(prompt));
    events.push(...(await drainAgentRun(run)));
    await ackScheduledCloudflareSessionPrompt(storage, prompt, { prefix });
  } catch (error) {
    failedSessionPrompts.push({
      error: describeError(error),
      id: sessionPromptId(prompt),
    });
  }
}

async function shouldRetryScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  const run = await createCloudflareDurableObjectHost({
    prefix,
    storage,
  }).store.runs.get(runId);
  return run ? isRetryableRunStatus(run.status) : true;
}

async function shouldRetryScheduledSessionPrompt(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledSessionPrompt
): Promise<boolean> {
  const runId = await scheduledSessionPromptRunId(storage, prefix, prompt);
  return runId
    ? await shouldRetryScheduledRun(storage, prefix, runId)
    : prompt.idempotencyKey !== undefined;
}

async function scheduledSessionPromptRunId(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledSessionPrompt
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

function sessionPromptId(prompt: CloudflareScheduledSessionPrompt): string {
  return prompt.idempotencyKey ?? prompt.runId ?? "<missing-run-id>";
}

function isRetryableRunStatus(status: RunStatus | undefined): boolean {
  return (
    status === "leased" ||
    status === "queued" ||
    status === "running" ||
    status === "suspended"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
