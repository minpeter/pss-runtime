import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import { resumeRun } from "./execution/resume";
import {
  createCheckpointSpyHost,
  createQueuedUserTurnRun,
} from "./execution-checkpoint-test-support";
import type { RuntimeLlm, RuntimeToolExecutionCheckpoint } from "./llm";
import { ToolExecutionNeedsRecoveryError } from "./llm-tool-execution";
import { assistantMessage } from "./test-fixtures";

describe("resumeRun checkpoint recovery", () => {
  it("passes tool execution checkpoints to resumed model calls", async () => {
    const { checkpoints, host } = createCheckpointSpyHost();
    const history: ModelMessage[] = [];
    await host.store.runs.create(createQueuedUserTurnRun());

    const llm: RuntimeLlm = async ({ toolExecution }) => {
      if (!toolExecution) {
        return [assistantMessage("NO TOOL EXECUTION")];
      }

      const checkpoint: RuntimeToolExecutionCheckpoint = {
        attempt: toolExecution.attempt,
        idempotencyKey: `${toolExecution.runId}:call-tool-1`,
        input: {},
        policy: "idempotent",
        toolCallId: "call-tool-1",
        toolName: "checkpointed_tool",
      };
      await toolExecution.beforeTool?.(checkpoint);
      await toolExecution.afterTool?.({
        ...checkpoint,
        output: { ok: true },
      });
      return [assistantMessage("DONE")];
    };

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        llm,
        loadState: () => Promise.resolve({ history }),
        runId: "run-1",
        saveState: (state) => {
          history.length = 0;
          history.push(...state.history);
          return Promise.resolve();
        },
      })
    ).resolves.toEqual({ status: "completed", steps: 1 });

    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "before-model",
      "before-tool",
      "after-tool",
      "after-model",
    ]);
    expect(checkpoints[1]?.pendingToolCall).toMatchObject({
      idempotencyKey: "run-1:call-tool-1",
      policy: "idempotent",
      toolName: "checkpointed_tool",
    });
    expect(checkpoints[2]?.pendingToolCall).toMatchObject({
      output: { ok: true },
      toolCallId: "call-tool-1",
    });
  });

  it("stops for manual recovery when resuming from a pending tool checkpoint", async () => {
    const host = createInMemoryExecutionHost();
    let llmCalls = 0;
    const pendingToolCall: RuntimeToolExecutionCheckpoint = {
      attempt: 1,
      idempotencyKey: "run-1:call-tool-1",
      input: {},
      policy: "manual-recovery",
      toolCallId: "call-tool-1",
      toolName: "dangerous_tool",
    };
    const llm: RuntimeLlm = () => {
      llmCalls += 1;
      return Promise.resolve([assistantMessage("SHOULD NOT RUN")]);
    };
    await host.store.runs.create(createQueuedUserTurnRun());
    await host.store.checkpoints.append(
      {
        checkpointId: "pending-tool",
        pendingToolCall,
        phase: "before-tool",
        runId: "run-1",
        runtimeState: { step: 1 },
        sessionSnapshot: { history: [] },
        version: 1,
      },
      { expectedVersion: 0 }
    );

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        llm,
        loadState: () => Promise.resolve({ history: [] }),
        runId: "run-1",
        saveState: () => Promise.resolve(),
      })
    ).rejects.toBeInstanceOf(ToolExecutionNeedsRecoveryError);
    expect(llmCalls).toBe(0);
  });
});
