import type { RunStatus } from "../execution";
import {
  type AlarmDrainState,
  eventSlotsRemaining,
  type NormalizedAlarmDrainBudget,
} from "./cloudflare-alarm-budget";
import type { CloudflareAlarmAgent } from "./cloudflare-alarm-drainer";
import {
  type AgentRunDrainResult,
  drainAgentRunWithBudget,
} from "./cloudflare-alarm-run-drain";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareSessionPrompt,
  type CloudflareDurableObjectStorage,
  type CloudflareScheduledSessionPrompt,
  createCloudflareDurableObjectHost,
} from "./cloudflare-host";

export async function resumeScheduledRun({
  agent,
  budget,
  prefix,
  runId,
  state,
  storage,
}: {
  readonly agent: CloudflareAlarmAgent;
  readonly budget: NormalizedAlarmDrainBudget;
  readonly prefix: string;
  readonly runId: string;
  readonly state: AlarmDrainState;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  try {
    const run = await agent.resume(runId);
    if (!run) {
      if (await shouldRetryScheduledRun(storage, prefix, runId)) {
        state.failedRuns.push({
          error: "Run was not claimable during this alarm.",
          id: runId,
        });
        return;
      }
      await ackScheduledCloudflareRun(storage, runId, { prefix });
      return;
    }
    state.resumedRuns.push(runId);
    appendRunDrainEvents(
      state,
      await drainAgentRunWithBudget(run, {
        deadlineMs: budget.deadlineMs,
        maxEvents: eventSlotsRemaining(state, budget),
        startedAt: budget.startedAt,
      })
    );
    if (shouldContinueRunDrain(state)) {
      return;
    }
    await ackScheduledCloudflareRun(storage, runId, { prefix });
  } catch (error) {
    state.failedRuns.push({ error: describeError(error), id: runId });
  }
}

export async function resumeScheduledSessionPrompt({
  agent,
  budget,
  prefix,
  prompt,
  state,
  storage,
}: {
  readonly agent: CloudflareAlarmAgent;
  readonly budget: NormalizedAlarmDrainBudget;
  readonly prefix: string;
  readonly prompt: CloudflareScheduledSessionPrompt;
  readonly state: AlarmDrainState;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  try {
    const runId = await scheduledSessionPromptRunId(storage, prefix, prompt);
    if (!runId) {
      state.failedSessionPrompts.push({
        error: "Session prompt did not include or resolve to a run id.",
        id: sessionPromptId(prompt),
      });
      return;
    }

    const run = await agent.resume(runId);
    if (!run) {
      if (await shouldRetryScheduledSessionPrompt(storage, prefix, prompt)) {
        state.failedSessionPrompts.push({
          error: "Session prompt was not claimable during this alarm.",
          id: sessionPromptId(prompt),
        });
        return;
      }
      await ackScheduledCloudflareSessionPrompt(storage, prompt, { prefix });
      return;
    }
    appendRunDrainEvents(
      state,
      await drainAgentRunWithBudget(run, {
        deadlineMs: budget.deadlineMs,
        maxEvents: eventSlotsRemaining(state, budget),
        startedAt: budget.startedAt,
      })
    );
    if (shouldContinueRunDrain(state)) {
      return;
    }
    state.consumedSessionPrompts.push(sessionPromptId(prompt));
    await ackScheduledCloudflareSessionPrompt(storage, prompt, { prefix });
  } catch (error) {
    state.failedSessionPrompts.push({
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

function appendRunDrainEvents(
  state: AlarmDrainState,
  result: AgentRunDrainResult
): void {
  state.events.push(...result.events);
  state.droppedEvents += result.droppedEvents;
  if (result.stoppedReason) {
    state.reasons.add(result.stoppedReason);
  }
}

function shouldContinueRunDrain(state: AlarmDrainState): boolean {
  return state.reasons.has("deadline") || state.reasons.has("event-budget");
}
