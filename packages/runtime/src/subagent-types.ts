import type { ExecutionHost } from "./execution/types";
import type { AgentEvent } from "./session/events";
import type { AgentInput, UserInput } from "./session/input";
import type { AgentRun } from "./session/run";
import type { NotifyOptions } from "./session/session";

export interface Subagent {
  readonly delegateToolName?: string;
  readonly description?: string;
  readonly name?: string;
  session(key: string): {
    delete(): Promise<void>;
    interrupt(): void;
    send(input: AgentInput): Promise<AgentRun>;
  };
}

export interface RuntimeInputSink {
  currentBackgroundGroupId?(): string | undefined;
  currentRunId?(): string | undefined;
  emitObserverEvent(event: AgentEvent): Promise<void>;
  enqueueRuntimeInput(input: UserInput, placement?: "turn-start"): void;
  notify(input: UserInput, options?: NotifyOptions): Promise<AgentRun>;
}

export interface CreateSubagentToolsOptions {
  readonly backgroundSubagents: boolean;
  readonly executionHost?: ExecutionHost;
  readonly parentAgentNamespace: string;
  readonly parentSession: RuntimeInputSink;
  readonly parentSessionKey: string;
  registerChildSession(
    parentSessionKey: string,
    cleanup: () => Promise<void>
  ): () => void;
  readonly subagents: readonly Subagent[];
}

export type JobStatus =
  | "aborted"
  | "cancelled"
  | "completed"
  | "error"
  | "pending"
  | "running";

export interface CompactSubagentResult {
  readonly error?: string;
  readonly eventCount: number;
  readonly result: Exclude<JobStatus, "cancelled" | "pending" | "running">;
  readonly run_in_background: false;
  readonly subagent: string;
  readonly text: string;
}

export interface SubagentRunResult {
  readonly result: CompactSubagentResult;
  readonly retainedEvents: readonly AgentEvent[];
}

export interface SubagentJob {
  readonly abort: () => void;
  readonly childRunId?: string;
  readonly childRunLeaseId?: string;
  readonly cleanup: () => Promise<void>;
  readonly dedupeKey?: string;
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly executionHost?: ExecutionHost;
  readonly groupId?: string;
  readonly id: string;
  readonly ownerNamespace?: string;
  readonly parentRunId?: string;
  readonly parentSessionKey?: string;
  promise: Promise<void>;
  result?: CompactSubagentResult;
  readonly sessionKey: string;
  settled: boolean;
  status: JobStatus;
  readonly subagent: string;
  readonly unregisterCleanup?: () => void;
}

export interface SubagentJobGroup {
  readonly completedEvents: Extract<AgentEvent, { type: "subagent-job-end" }>[];
  readonly failedNotifiedJobIds: Set<string>;
  finalNotified: boolean;
  readonly id: string;
  readonly jobIds: Set<string>;
}

export interface DelegateInput {
  readonly description?: string;
  readonly prompt: AgentInput;
  readonly run_in_background?: boolean;
  readonly sessionKey?: string;
}

export interface BackgroundOutputInput {
  readonly block?: boolean;
  readonly task_id: string;
  readonly timeout?: number;
}

export interface BackgroundCancelInput {
  readonly task_id: string;
}
