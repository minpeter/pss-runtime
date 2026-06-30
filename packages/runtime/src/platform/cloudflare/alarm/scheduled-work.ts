import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareThreadPrompt,
  type CloudflareDurableObjectStorage,
  type CloudflareScheduledThreadPrompt,
} from "../host/durable-object-host";
import {
  type AlarmDrainState,
  eventSlotsRemaining,
  type NormalizedAlarmDrainBudget,
} from "./budget";
import type {
  CloudflareAlarmAgentForRun,
  CloudflareAlarmEventHandler,
} from "./run-context";
import {
  type AgentTurnDrainResult,
  drainAgentTurnWithBudget,
} from "./run-drain";
import {
  prepareScheduledNotificationRetry,
  scheduledRunContext,
  scheduledThreadPromptContext,
  shouldRetryScheduledRun,
  shouldRetryScheduledThreadPrompt,
  threadPromptId,
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
    if (!context.threadKey) {
      await ackScheduledCloudflareRun(storage, runId, { prefix });
      return;
    }
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
    const drainResult = await drainAgentTurnWithBudget(run, {
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
      await prepareScheduledNotificationRetry(storage, prefix, runId);
      return;
    }
    if (shouldContinueRunDrain(state)) {
      await prepareScheduledNotificationRetry(storage, prefix, runId);
      return;
    }
    await ackScheduledCloudflareRun(storage, runId, { prefix });
  } catch (error) {
    state.failedRuns.push({
      error: error instanceof Error ? error.message : String(error),
      id: runId,
    });
  }
}

export async function resumeScheduledThreadPrompt({
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
  readonly prompt: CloudflareScheduledThreadPrompt;
  readonly state: AlarmDrainState;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  try {
    const context = await scheduledThreadPromptContext(storage, prefix, prompt);
    if (!context) {
      state.failedThreadPrompts.push({
        error: "Thread prompt did not include or resolve to a run id.",
        id: threadPromptId(prompt),
      });
      await ackScheduledCloudflareThreadPrompt(storage, prompt, { prefix });
      return;
    }

    const agent = await agentForRun(context);
    const run = await agent.resume(context.runId);
    if (!run) {
      if (await shouldRetryScheduledThreadPrompt(storage, prefix, prompt)) {
        state.failedThreadPrompts.push({
          error: "Thread prompt was not claimable during this alarm.",
          id: threadPromptId(prompt),
        });
        return;
      }
      await ackScheduledCloudflareThreadPrompt(storage, prompt, { prefix });
      return;
    }
    const drainResult = await drainAgentTurnWithBudget(run, {
      deadlineMs: budget.deadlineMs,
      maxEvents: eventSlotsRemaining(state, budget),
      onEvent: onEvent ? (event) => onEvent(context, event) : undefined,
      startedAt: budget.startedAt,
    });
    appendRunDrainEvents(state, drainResult);
    if (
      failOnTurnError &&
      appendTurnErrorFailure(
        state.failedThreadPrompts,
        threadPromptId(prompt),
        drainResult
      )
    ) {
      if (
        !(await prepareScheduledNotificationRetry(
          storage,
          prefix,
          context.runId
        ))
      ) {
        await ackScheduledCloudflareThreadPrompt(storage, prompt, { prefix });
      }
      return;
    }
    if (shouldContinueRunDrain(state)) {
      if (
        !(await prepareScheduledNotificationRetry(
          storage,
          prefix,
          context.runId
        ))
      ) {
        await ackScheduledCloudflareThreadPrompt(storage, prompt, { prefix });
      }
      return;
    }
    state.consumedThreadPrompts.push(threadPromptId(prompt));
    await ackScheduledCloudflareThreadPrompt(storage, prompt, { prefix });
  } catch (error) {
    state.failedThreadPrompts.push({
      error: error instanceof Error ? error.message : String(error),
      id: threadPromptId(prompt),
    });
  }
}

function appendRunDrainEvents(
  state: AlarmDrainState,
  result: AgentTurnDrainResult
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
  result: AgentTurnDrainResult
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
