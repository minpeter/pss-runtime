import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareSessionPrompt,
  type CloudflareDurableObjectStorage,
  type CloudflareScheduledSessionPrompt,
} from "../host/durable-object-host";
import {
  type AlarmDrainState,
  eventSlotsRemaining,
  type NormalizedAlarmDrainBudget,
} from "./budget";
import type {
  CloudflareAlarmAgentForRun,
  CloudflareAlarmEventHandler,
} from "./drainer";
import { type AgentRunDrainResult, drainAgentRunWithBudget } from "./run-drain";
import {
  scheduledRunContext,
  scheduledSessionPromptContext,
  sessionPromptId,
  shouldRetryScheduledRun,
  shouldRetryScheduledSessionPrompt,
} from "./scheduled-work-context";

export async function resumeScheduledRun({
  agentForRun,
  budget,
  failOnTurnError,
  onEvent,
  prefix,
  runId,
  state,
  storage,
}: {
  readonly agentForRun: CloudflareAlarmAgentForRun;
  readonly budget: NormalizedAlarmDrainBudget;
  readonly failOnTurnError: boolean;
  readonly onEvent?: CloudflareAlarmEventHandler;
  readonly prefix: string;
  readonly runId: string;
  readonly state: AlarmDrainState;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  try {
    const context = await scheduledRunContext(storage, prefix, runId);
    const agent = await agentForRun(context);
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
    const drainResult = await drainAgentRunWithBudget(run, {
      deadlineMs: budget.deadlineMs,
      maxEvents: eventSlotsRemaining(state, budget),
      onEvent: onEvent ? (event) => onEvent(context, event) : undefined,
      startedAt: budget.startedAt,
    });
    appendRunDrainEvents(state, drainResult);
    if (
      failOnTurnError &&
      appendTurnErrorFailure(state.failedRuns, runId, drainResult)
    ) {
      return;
    }
    if (shouldContinueRunDrain(state)) {
      return;
    }
    await ackScheduledCloudflareRun(storage, runId, { prefix });
  } catch (error) {
    state.failedRuns.push({ error: describeError(error), id: runId });
  }
}

export async function resumeScheduledSessionPrompt({
  agentForRun,
  budget,
  failOnTurnError,
  onEvent,
  prefix,
  prompt,
  state,
  storage,
}: {
  readonly agentForRun: CloudflareAlarmAgentForRun;
  readonly budget: NormalizedAlarmDrainBudget;
  readonly failOnTurnError: boolean;
  readonly onEvent?: CloudflareAlarmEventHandler;
  readonly prefix: string;
  readonly prompt: CloudflareScheduledSessionPrompt;
  readonly state: AlarmDrainState;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  try {
    const context = await scheduledSessionPromptContext(
      storage,
      prefix,
      prompt
    );
    if (!context) {
      state.failedSessionPrompts.push({
        error: "Session prompt did not include or resolve to a run id.",
        id: sessionPromptId(prompt),
      });
      return;
    }

    const agent = await agentForRun(context);
    const run = await agent.resume(context.runId);
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
    const drainResult = await drainAgentRunWithBudget(run, {
      deadlineMs: budget.deadlineMs,
      maxEvents: eventSlotsRemaining(state, budget),
      onEvent: onEvent ? (event) => onEvent(context, event) : undefined,
      startedAt: budget.startedAt,
    });
    appendRunDrainEvents(state, drainResult);
    if (
      failOnTurnError &&
      appendTurnErrorFailure(
        state.failedSessionPrompts,
        sessionPromptId(prompt),
        drainResult
      )
    ) {
      return;
    }
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

function appendTurnErrorFailure(
  failedWork: AlarmDrainState["failedRuns"],
  id: string,
  result: AgentRunDrainResult
): boolean {
  const turnError = result.events.find((event) => event.type === "turn-error");
  if (!turnError) {
    return false;
  }

  failedWork.push({ error: turnError.message, id });
  return true;
}

function shouldContinueRunDrain(state: AlarmDrainState): boolean {
  return state.reasons.has("deadline") || state.reasons.has("event-budget");
}
