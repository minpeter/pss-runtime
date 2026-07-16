import type { ModelMessage } from "ai";
import {
  generateModelStep,
  type ModelGenerationOptions,
  type ModelStepOutput,
  type RuntimeToolExecutionContext,
} from "../../llm/llm";
import { persistedToolExecutionCheckpoint } from "../../llm/tool-execution";
import { modelMessageToAgentEvents } from "../../thread/protocol/mapping";
import type { AgentHost } from "../host/types";
import {
  appendCheckpoint,
  resumeStateCheckpointReference,
} from "./checkpoints";
import type { ResumeRunState } from "./types";

export async function readModelOutput({
  history,
  model,
  signal,
  toolExecution,
}: {
  readonly history: readonly ModelMessage[];
  readonly model: ModelGenerationOptions;
  readonly signal: AbortSignal;
  readonly toolExecution: RuntimeToolExecutionContext;
}): Promise<ModelStepOutput | "aborted"> {
  try {
    return await generateModelStep({
      history,
      ...model,
      signal,
      toolExecution,
    });
  } catch (error) {
    if (signal.aborted) {
      return "aborted";
    }

    throw error;
  }
}

export async function createResumeToolExecution({
  host,
  runId,
  threadSnapshot,
  stepNumber,
}: {
  readonly host: AgentHost;
  readonly runId: string;
  readonly threadSnapshot: ResumeRunState;
  readonly stepNumber: number;
}): Promise<RuntimeToolExecutionContext> {
  const run = await host.store.turns.get(runId);
  return {
    attempt: run?.lease?.attempt ?? 1,
    afterTool: async (checkpoint) => {
      await appendCheckpoint({
        host,
        pendingToolCall: persistedToolExecutionCheckpoint(checkpoint),
        phase: "after-tool",
        runId,
        runtimeState: {
          step: stepNumber,
          toolCallId: checkpoint.toolCallId,
          toolName: checkpoint.toolName,
        },
        threadSnapshot: resumeStateCheckpointReference(threadSnapshot),
      });
      return;
    },
    beforeTool: async (checkpoint) => {
      await appendCheckpoint({
        host,
        pendingToolCall: persistedToolExecutionCheckpoint(checkpoint),
        phase: "before-tool",
        runId,
        runtimeState: {
          step: stepNumber,
          toolCallId: checkpoint.toolCallId,
          toolName: checkpoint.toolName,
        },
        threadSnapshot: resumeStateCheckpointReference(threadSnapshot),
      });
    },
    runId,
  };
}

export function appendModelOutput(
  state: ResumeRunState,
  output: ModelStepOutput
): ResumeRunState {
  return {
    history: [
      ...state.history,
      ...output.map((message) => structuredClone(message)),
    ],
  };
}

export async function emitModelOutputEvents({
  host,
  output,
  runId,
}: {
  readonly host: AgentHost;
  readonly output: ModelStepOutput;
  readonly runId: string;
}): Promise<boolean> {
  let shouldContinue = false;

  for (const message of output) {
    for (const event of modelMessageToAgentEvents(message)) {
      await host.store.events.append(runId, event);
      if (event.type === "tool-call") {
        shouldContinue = true;
      }
    }
  }

  return shouldContinue;
}
