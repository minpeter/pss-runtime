import type { AgentEvent, AgentRun } from "../../index";
import {
  type CloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
  rescheduleCloudflareAlarm,
} from "../host/durable-object-host";
import {
  type AlarmDrainState,
  type CloudflareAlarmContinuationReason,
  type CloudflareAlarmDrainBudget,
  createAlarmDrainState,
  type FailedScheduledWork,
  type NormalizedAlarmDrainBudget,
  normalizeAlarmDrainBudget,
  shouldStopRuns,
  shouldStopSessionPrompts,
} from "./budget";
import {
  resumeScheduledRun,
  resumeScheduledSessionPrompt,
} from "./scheduled-work";

export type {
  CloudflareAlarmContinuationReason,
  CloudflareAlarmDrainBudget,
  FailedScheduledWork,
} from "./budget";

export interface CloudflareAlarmDrainSummary {
  readonly consumedSessionPrompts: readonly string[];
  readonly continuationReasons: readonly CloudflareAlarmContinuationReason[];
  readonly continuationScheduled: boolean;
  readonly droppedEvents: number;
  readonly events: readonly AgentEvent[];
  readonly failedRuns: readonly FailedScheduledWork[];
  readonly failedSessionPrompts: readonly FailedScheduledWork[];
  readonly markers: readonly string[];
  readonly remainingRuns: number;
  readonly remainingSessionPrompts: number;
  readonly resumedRuns: readonly string[];
}

export interface CloudflareAlarmAgent {
  resume(runId: string): Promise<AgentRun | null>;
}

export type CloudflareAlarmRunSource = "scheduled-run" | "session-prompt";

export interface CloudflareAlarmRunContext {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId: string;
  readonly sessionKey: string;
  readonly source: CloudflareAlarmRunSource;
}

export type CloudflareAlarmAgentForRun = (
  context: CloudflareAlarmRunContext
) => CloudflareAlarmAgent | Promise<CloudflareAlarmAgent>;

export type CloudflareAlarmEventHandler = (
  context: CloudflareAlarmRunContext,
  event: AgentEvent
) => Promise<void> | void;

type CloudflareAlarmAgentSource =
  | {
      readonly agent: CloudflareAlarmAgent;
      readonly agentForRun?: never;
    }
  | {
      readonly agent?: never;
      readonly agentForRun: CloudflareAlarmAgentForRun;
    };

export class CloudflareAlarmDrainFailureError extends Error {
  readonly summary: CloudflareAlarmDrainSummary;

  constructor(summary: CloudflareAlarmDrainSummary) {
    super("Cloudflare alarm drain completed with failed scheduled work.");
    this.name = "CloudflareAlarmDrainFailureError";
    this.summary = summary;
  }
}

export async function drainCloudflareAlarm({
  continuationRunAfterMs,
  deadlineMs,
  failOnTurnError,
  failureRunAfterMs,
  maxEvents,
  maxRuns,
  maxSessionPrompts,
  onEvent,
  prefix,
  storage,
  throwOnFailure,
  ...agentSource
}: CloudflareAlarmAgentSource & {
  readonly failOnTurnError?: boolean;
  readonly onEvent?: CloudflareAlarmEventHandler;
  readonly prefix: string;
  readonly storage: CloudflareDurableObjectStorage;
} & CloudflareAlarmDrainBudget): Promise<CloudflareAlarmDrainSummary> {
  const budget = normalizeAlarmDrainBudget({
    continuationRunAfterMs,
    deadlineMs,
    failureRunAfterMs,
    maxEvents,
    maxRuns,
    maxSessionPrompts,
    throwOnFailure,
  });
  const state = createAlarmDrainState();
  const agentForRun = normalizeAgentForRun(agentSource);

  await drainRuns({
    agentForRun,
    budget,
    failOnTurnError: failOnTurnError ?? false,
    onEvent,
    prefix,
    state,
    storage,
  });
  await drainSessionPrompts({
    agentForRun,
    budget,
    failOnTurnError: failOnTurnError ?? false,
    onEvent,
    prefix,
    state,
    storage,
  });

  const summary = await summarizeDrain({ budget, prefix, state, storage });
  if (budget.throwOnFailure && hasFailures(summary)) {
    throw new CloudflareAlarmDrainFailureError(summary);
  }
  return summary;
}

async function drainRuns(options: DrainLoopOptions): Promise<void> {
  for (const runId of await listScheduledCloudflareRuns(options.storage, {
    prefix: options.prefix,
  })) {
    if (shouldStopRuns(options.state, options.budget)) {
      break;
    }
    options.state.runAttempts += 1;
    await resumeScheduledRun({ ...options, runId });
  }
}

async function drainSessionPrompts(options: DrainLoopOptions): Promise<void> {
  const prompts = await listScheduledCloudflareSessionPrompts(options.storage, {
    prefix: options.prefix,
  });
  for (const prompt of prompts) {
    if (shouldStopSessionPrompts(options.state, options.budget)) {
      break;
    }
    options.state.sessionPromptAttempts += 1;
    await resumeScheduledSessionPrompt({ ...options, prompt });
  }
}

async function summarizeDrain({
  budget,
  prefix,
  state,
  storage,
}: {
  readonly budget: NormalizedAlarmDrainBudget;
  readonly prefix: string;
  readonly state: AlarmDrainState;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<CloudflareAlarmDrainSummary> {
  const remainingRuns = await listScheduledCloudflareRuns(storage, { prefix });
  const remainingPrompts = await listScheduledCloudflareSessionPrompts(
    storage,
    {
      prefix,
    }
  );
  if (state.failedRuns.length > 0 || state.failedSessionPrompts.length > 0) {
    state.reasons.add("failure");
  }
  const continuationScheduled = shouldRearm(
    state,
    remainingRuns.length,
    remainingPrompts.length
  );
  if (continuationScheduled) {
    await rescheduleCloudflareAlarm(storage, {
      runAfterMs: state.reasons.has("failure")
        ? budget.failureRunAfterMs
        : budget.continuationRunAfterMs,
    });
  }
  return {
    consumedSessionPrompts: state.consumedSessionPrompts,
    continuationReasons: [...state.reasons],
    continuationScheduled,
    droppedEvents: state.droppedEvents,
    events: state.events,
    failedRuns: state.failedRuns,
    failedSessionPrompts: state.failedSessionPrompts,
    markers: markersFor(state.reasons),
    remainingRuns: remainingRuns.length,
    remainingSessionPrompts: remainingPrompts.length,
    resumedRuns: state.resumedRuns,
  };
}

interface DrainLoopOptions {
  readonly agentForRun: CloudflareAlarmAgentForRun;
  readonly budget: NormalizedAlarmDrainBudget;
  readonly failOnTurnError: boolean;
  readonly onEvent?: CloudflareAlarmEventHandler;
  readonly prefix: string;
  readonly state: AlarmDrainState;
  readonly storage: CloudflareDurableObjectStorage;
}

function normalizeAgentForRun(
  source: CloudflareAlarmAgentSource
): CloudflareAlarmAgentForRun {
  if (source.agentForRun) {
    return source.agentForRun;
  }

  return () => source.agent;
}

function shouldRearm(
  state: AlarmDrainState,
  remainingRuns: number,
  remainingPrompts: number
): boolean {
  return state.reasons.size > 0 && (remainingRuns > 0 || remainingPrompts > 0);
}

function hasFailures(summary: CloudflareAlarmDrainSummary): boolean {
  return (
    summary.failedRuns.length > 0 || summary.failedSessionPrompts.length > 0
  );
}

function markersFor(
  reasons: ReadonlySet<CloudflareAlarmContinuationReason>
): readonly string[] {
  const markers = ["alarm:resume", "resume:session-prompt"];
  if (reasons.size > 0) {
    markers.push("alarm:continuation-rearm");
  }
  if (reasons.has("failure")) {
    markers.push("alarm:failure");
  }
  return markers;
}
