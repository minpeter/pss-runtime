import type { ModelMessage } from "ai";
import type { ModelGenerationOptions } from "../../llm/llm";
import type { AgentHost } from "../host/types";

export interface ResumeRunState {
  readonly history: readonly ModelMessage[];
}

export interface ResumeRunBudget {
  readonly maxSteps: number;
}

export type ResumeTurnStatus = "aborted" | "completed" | "suspended";

export interface ResumeRunResult {
  readonly status: ResumeTurnStatus;
  readonly steps: number;
}

export interface ResumeRunOptions {
  readonly budget: ResumeRunBudget;
  readonly host: AgentHost;
  readonly loadState: () => Promise<ResumeRunState>;
  readonly model: ModelGenerationOptions;
  readonly runId: string;
  readonly saveState: (state: ResumeRunState) => Promise<void>;
  readonly signal?: AbortSignal;
}
