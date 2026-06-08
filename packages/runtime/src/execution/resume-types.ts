import type { ModelMessage } from "ai";
import type { RuntimeLlm } from "../llm";
import type { ExecutionHost } from "./types";

export interface ResumeRunState {
  readonly history: readonly ModelMessage[];
}

export interface ResumeRunBudget {
  readonly maxSteps: number;
}

export type ResumeRunStatus = "aborted" | "completed" | "suspended";

export interface ResumeRunResult {
  readonly status: ResumeRunStatus;
  readonly steps: number;
}

export interface ResumeRunOptions {
  readonly budget: ResumeRunBudget;
  readonly host: ExecutionHost;
  readonly llm: RuntimeLlm;
  readonly loadState: () => Promise<ResumeRunState>;
  readonly runId: string;
  readonly saveState: (state: ResumeRunState) => Promise<void>;
  readonly signal?: AbortSignal;
}
