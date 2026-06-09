import type { AgentEvent } from "../index";

export type CloudflareAlarmContinuationReason =
  | "deadline"
  | "event-budget"
  | "failure"
  | "run-budget"
  | "session-prompt-budget";

export interface CloudflareAlarmDrainBudget {
  readonly continuationRunAfterMs?: number;
  readonly deadlineMs?: number;
  readonly failureRunAfterMs?: number;
  readonly maxEvents?: number;
  readonly maxRuns?: number;
  readonly maxSessionPrompts?: number;
  readonly throwOnFailure?: boolean;
}

export interface FailedScheduledWork {
  readonly error: string;
  readonly id: string;
}

export interface AlarmDrainState {
  readonly consumedSessionPrompts: string[];
  droppedEvents: number;
  readonly events: AgentEvent[];
  readonly failedRuns: FailedScheduledWork[];
  readonly failedSessionPrompts: FailedScheduledWork[];
  readonly reasons: Set<CloudflareAlarmContinuationReason>;
  readonly resumedRuns: string[];
  runAttempts: number;
  sessionPromptAttempts: number;
}

export interface NormalizedAlarmDrainBudget {
  readonly continuationRunAfterMs: number;
  readonly deadlineMs: number;
  readonly failureRunAfterMs: number;
  readonly maxEvents: number;
  readonly maxRuns: number;
  readonly maxSessionPrompts: number;
  readonly startedAt: number;
  readonly throwOnFailure: boolean;
}

const defaultAlarmDrainBudget = {
  continuationRunAfterMs: 0,
  deadlineMs: 30_000,
  failureRunAfterMs: 1000,
  maxEvents: 1000,
  maxRuns: 25,
  maxSessionPrompts: 25,
  throwOnFailure: false,
} satisfies Required<CloudflareAlarmDrainBudget>;

export function createAlarmDrainState(): AlarmDrainState {
  return {
    consumedSessionPrompts: [],
    droppedEvents: 0,
    events: [],
    failedRuns: [],
    failedSessionPrompts: [],
    reasons: new Set<CloudflareAlarmContinuationReason>(),
    resumedRuns: [],
    runAttempts: 0,
    sessionPromptAttempts: 0,
  };
}

export function normalizeAlarmDrainBudget(
  budget: CloudflareAlarmDrainBudget = {}
): NormalizedAlarmDrainBudget {
  return {
    continuationRunAfterMs: nonNegativeInteger(
      budget.continuationRunAfterMs ??
        defaultAlarmDrainBudget.continuationRunAfterMs
    ),
    deadlineMs: nonNegativeInteger(
      budget.deadlineMs ?? defaultAlarmDrainBudget.deadlineMs
    ),
    failureRunAfterMs: nonNegativeInteger(
      budget.failureRunAfterMs ?? defaultAlarmDrainBudget.failureRunAfterMs
    ),
    maxEvents: nonNegativeInteger(
      budget.maxEvents ?? defaultAlarmDrainBudget.maxEvents
    ),
    maxRuns: nonNegativeInteger(
      budget.maxRuns ?? defaultAlarmDrainBudget.maxRuns
    ),
    maxSessionPrompts: nonNegativeInteger(
      budget.maxSessionPrompts ?? defaultAlarmDrainBudget.maxSessionPrompts
    ),
    startedAt: Date.now(),
    throwOnFailure:
      budget.throwOnFailure ?? defaultAlarmDrainBudget.throwOnFailure,
  };
}

export function eventSlotsRemaining(
  state: AlarmDrainState,
  budget: NormalizedAlarmDrainBudget
): number {
  return Math.max(0, budget.maxEvents - state.events.length);
}

export function shouldStopForDeadline(
  budget: NormalizedAlarmDrainBudget
): boolean {
  return Date.now() - budget.startedAt >= budget.deadlineMs;
}

export function shouldStopRuns(
  state: AlarmDrainState,
  budget: NormalizedAlarmDrainBudget
): boolean {
  if (shouldStopForDeadline(budget)) {
    state.reasons.add("deadline");
    return true;
  }
  if (shouldStopForEventBudget(state, budget)) {
    return true;
  }
  if (state.runAttempts >= budget.maxRuns) {
    state.reasons.add("run-budget");
    return true;
  }
  return false;
}

export function shouldStopSessionPrompts(
  state: AlarmDrainState,
  budget: NormalizedAlarmDrainBudget
): boolean {
  if (shouldStopForDeadline(budget)) {
    state.reasons.add("deadline");
    return true;
  }
  if (shouldStopForEventBudget(state, budget)) {
    return true;
  }
  if (state.sessionPromptAttempts >= budget.maxSessionPrompts) {
    state.reasons.add("session-prompt-budget");
    return true;
  }
  return false;
}

function shouldStopForEventBudget(
  state: AlarmDrainState,
  budget: NormalizedAlarmDrainBudget
): boolean {
  if (state.events.length < budget.maxEvents) {
    return false;
  }
  state.reasons.add("event-budget");
  return true;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(value));
}
