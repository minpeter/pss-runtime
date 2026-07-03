import type { Agent } from "../../../agent/core/agent";
import type {
  ScheduledThreadPrompt,
  ScheduledWorkKind as SharedScheduledWorkKind,
} from "../../../execution/scheduled-work";
import type { AgentEvent } from "../../../thread/protocol/events";

export type NodeScheduledThreadPrompt = ScheduledThreadPrompt;

export interface NodeScheduledWorkListOptions {
  readonly limit?: number;
  readonly nowMs?: number;
}

export interface NodeScheduledWorkAppendOptions {
  readonly runAfterMs?: number;
}

export interface NodeScheduledWorkDrainResult {
  readonly ackedRuns: readonly string[];
  readonly ackedThreadPrompts: readonly NodeScheduledThreadPrompt[];
  readonly events: readonly AgentEvent[];
  readonly skippedRuns: readonly string[];
  readonly skippedThreadPrompts: readonly NodeScheduledThreadPrompt[];
}

export interface NodeScheduledWorkDrainOptions {
  readonly agentForRun: (
    context: NodeScheduledWorkRunContext
  ) => Agent | Promise<Agent>;
  readonly directory: string;
  readonly limit?: number;
  readonly nowMs?: number;
  readonly onEvent?: (
    context: NodeScheduledWorkRunContext,
    event: AgentEvent
  ) => void;
}

export type NodeScheduledWorkRunContext =
  | {
      readonly kind: "run";
      readonly runId: string;
    }
  | {
      readonly idempotencyKey?: string;
      readonly kind: "thread-prompt";
      readonly notificationId?: string;
      readonly runId: string;
      readonly threadKey: string;
    };

export type ScheduledWorkKind = SharedScheduledWorkKind;

export interface StoredScheduledWork<T> {
  readonly createdAt: number;
  readonly dueAt: number;
  readonly payload: T;
  readonly workId: string;
}

export type StoredScheduledRunWork = StoredScheduledWork<string>;
export type StoredScheduledThreadPromptWork =
  StoredScheduledWork<NodeScheduledThreadPrompt>;
