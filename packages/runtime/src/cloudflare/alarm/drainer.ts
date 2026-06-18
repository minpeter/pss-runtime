import type { AgentEvent, AgentRun } from "../../index";
import {
  type CloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
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
  shouldStopThreadPrompts,
} from "./budget";
import {
  resumeScheduledRun,
  resumeScheduledThreadPrompt,
} from "./scheduled-work";

export type {
  CloudflareAlarmContinuationReason,
  CloudflareAlarmDrainBudget,
  FailedScheduledWork,
} from "./budget";

export interface CloudflareAlarmDrainSummary {
  readonly consumedThreadPrompts: readonly string[];
  readonly continuationReasons: readonly CloudflareAlarmContinuationReason[];
  readonly continuationScheduled: boolean;
  readonly droppedEvents: number;
  readonly events: readonly AgentEvent[];
  readonly failedRuns: readonly FailedScheduledWork[];
  readonly failedThreadPrompts: readonly FailedScheduledWork[];
  readonly markers: readonly string[];
  readonly remainingRuns: number;
  readonly remainingThreadPrompts: number;
  readonly resumedRuns: readonly string[];
}

export interface CloudflareAlarmAgent {
  resume(runId: string): Promise<AgentRun | null>;
}

export type CloudflareAlarmRunSource = "scheduled-run" | "thread-prompt";

export interface CloudflareAlarmRunContext {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId: string;
  readonly source: CloudflareAlarmRunSource;
  readonly threadKey: string;
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
  maxThreadPrompts,
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
    maxThreadPrompts,
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
  await drainThreadPrompts({
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

async function drainThreadPrompts(options: DrainLoopOptions): Promise<void> {
  const prompts = await listScheduledCloudflareThreadPrompts(options.storage, {
    prefix: options.prefix,
  });
  for (const prompt of prompts) {
    if (shouldStopThreadPrompts(options.state, options.budget)) {
      break;
    }
    options.state.threadPromptAttempts += 1;
    await resumeScheduledThreadPrompt({ ...options, prompt });
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
  const remainingPrompts = await listScheduledCloudflareThreadPrompts(storage, {
    prefix,
  });
  if (state.failedRuns.length > 0 || state.failedThreadPrompts.length > 0) {
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
    consumedThreadPrompts: state.consumedThreadPrompts,
    continuationReasons: [...state.reasons],
    continuationScheduled,
    droppedEvents: state.droppedEvents,
    events: state.events,
    failedRuns: state.failedRuns,
    failedThreadPrompts: state.failedThreadPrompts,
    markers: markersFor(state.reasons),
    remainingRuns: remainingRuns.length,
    remainingThreadPrompts: remainingPrompts.length,
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
    summary.failedRuns.length > 0 || summary.failedThreadPrompts.length > 0
  );
}

function markersFor(
  reasons: ReadonlySet<CloudflareAlarmContinuationReason>
): readonly string[] {
  const markers = ["alarm:resume", "resume:thread-prompt"];
  if (reasons.size > 0) {
    markers.push("alarm:continuation-rearm");
  }
  if (reasons.has("failure")) {
    markers.push("alarm:failure");
  }
  return markers;
}
