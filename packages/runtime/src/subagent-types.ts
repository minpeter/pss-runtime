import type { AgentEvent } from "./session/events";
import type { AgentInput, UserInput } from "./session/input";
import type { AgentRun } from "./session/run";

export interface Subagent {
  readonly description?: string;
  readonly name?: string;
  session(key: string): {
    delete(): Promise<void>;
    interrupt(): void;
    send(input: AgentInput): Promise<AgentRun>;
  };
}

export interface RuntimeInputSink {
  emitObserverEvent(event: AgentEvent): void;
  enqueueRuntimeInput(input: UserInput, placement?: "turn-start"): void;
}

export interface CreateSubagentToolsOptions {
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
  readonly events: readonly AgentEvent[];
  readonly result: CompactSubagentResult;
}

export interface SubagentJob {
  readonly abort: () => void;
  readonly cleanup: () => Promise<void>;
  readonly description?: string;
  readonly id: string;
  promise: Promise<void>;
  result?: CompactSubagentResult;
  readonly sessionKey: string;
  settled: boolean;
  status: JobStatus;
  readonly subagent: string;
  readonly unregisterCleanup?: () => void;
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
