import {
  appendCheckpoint,
  resumeStepFromCheckpoint,
  throwIfManualToolRecoveryRequired,
} from "./resume-checkpoints";
import {
  appendModelOutput,
  createResumeToolExecution,
  emitModelOutputEvents,
  readModelOutput,
} from "./resume-llm";
import type { ResumeRunOptions, ResumeRunResult } from "./resume-types";

export type {
  ResumeRunBudget,
  ResumeRunOptions,
  ResumeRunResult,
  ResumeRunState,
  ResumeRunStatus,
} from "./resume-types";

export async function resumeRun(
  options: ResumeRunOptions
): Promise<ResumeRunResult> {
  const signal = options.signal ?? new AbortController().signal;
  if (options.budget.maxSteps <= 0) {
    return { status: "suspended", steps: 0 };
  }

  const initialCheckpoint = await options.host.store.checkpoints.latest(
    options.runId
  );
  throwIfManualToolRecoveryRequired(initialCheckpoint);
  let nextStep = resumeStepFromCheckpoint(initialCheckpoint);
  let steps = 0;

  while (steps < options.budget.maxSteps) {
    if (signal.aborted) {
      return { status: "aborted", steps };
    }

    if (nextStep.phase === "new-step") {
      await options.host.store.events.append(options.runId, {
        type: "step-start",
      });
      const state = await options.loadState();
      await appendCheckpoint({
        host: options.host,
        phase: "before-model",
        runId: options.runId,
        runtimeState: { step: nextStep.stepNumber },
        sessionSnapshot: state,
      });
    }

    const stateBeforeModel = await options.loadState();
    const toolExecution = await createResumeToolExecution({
      host: options.host,
      runId: options.runId,
      sessionSnapshot: stateBeforeModel,
      stepNumber: nextStep.stepNumber,
    });
    const output = await readModelOutput({
      history: stateBeforeModel.history,
      model: options.model,
      signal,
      toolExecution,
    });
    if (output === "aborted") {
      return { status: "aborted", steps };
    }

    const stateAfterModel = appendModelOutput(stateBeforeModel, output);
    await options.saveState(stateAfterModel);
    await appendCheckpoint({
      host: options.host,
      phase: "after-model",
      runId: options.runId,
      runtimeState: { step: nextStep.stepNumber },
      sessionSnapshot: stateAfterModel,
    });

    const shouldContinue = await emitModelOutputEvents({
      host: options.host,
      output,
      runId: options.runId,
    });
    await options.host.store.events.append(options.runId, {
      type: "step-end",
    });
    steps += 1;

    if (!shouldContinue) {
      return { status: "completed", steps };
    }

    if (steps >= options.budget.maxSteps) {
      await appendCheckpoint({
        host: options.host,
        phase: "suspended",
        runId: options.runId,
        runtimeState: { step: nextStep.stepNumber },
        sessionSnapshot: stateAfterModel,
      });
      return { status: "suspended", steps };
    }

    nextStep = {
      phase: "new-step",
      stepNumber: nextStep.stepNumber + 1,
    };
  }

  return { status: "suspended", steps };
}
