import type { ModelMessage } from "ai";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "../../execution/memory";
import { resumeRun } from "../../execution/resume/resume";
import type { RuntimeToolExecutionCheckpoint } from "../../llm/llm";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution";
import {
  createCheckpointSpyHost,
  createQueuedUserTurnRun,
} from "../../testing/execution-checkpoint-test-support";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4ToolCall,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createScriptedModelOptions,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../../thread/protocol/mapping";

describe("resumeRun checkpoint recovery", () => {
  it("passes tool execution checkpoints to resumed model calls", async () => {
    const { checkpoints, host } = createCheckpointSpyHost();
    const history: ModelMessage[] = [
      userTextToModelMessage(userText("queued")),
    ];
    await host.store.runs.create(createQueuedUserTurnRun());

    const model = createMockLanguageModelV4([
      mockLanguageModelV4ToolCall({
        input: {},
        toolCallId: "call-tool-1",
        toolName: "checkpointed_tool",
      }),
    ]);
    const checkpointedTool = {
      ...tool({
        execute: () => ({ ok: true }),
        inputSchema: jsonSchema({
          additionalProperties: true,
          properties: {},
          type: "object",
        }),
      }),
      retryPolicy: "idempotent" as const,
    };

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        model: {
          model,
          tools: { checkpointed_tool: checkpointedTool },
        },
        loadState: () => Promise.resolve({ history }),
        runId: "run-1",
        saveState: (state) => {
          history.length = 0;
          history.push(...state.history);
          return Promise.resolve();
        },
      })
    ).resolves.toEqual({ status: "suspended", steps: 1 });

    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "before-model",
      "before-tool",
      "after-tool",
      "after-model",
      "suspended",
    ]);
    expect(checkpoints[1]?.pendingToolCall).toMatchObject({
      idempotencyKey: "run-1:call-tool-1",
      policy: "idempotent",
      toolName: "checkpointed_tool",
    });
    expect(checkpoints[1]?.pendingToolCall).not.toHaveProperty("input");
    expect(checkpoints[2]?.pendingToolCall).toMatchObject({
      toolCallId: "call-tool-1",
    });
    expect(checkpoints[2]?.pendingToolCall).not.toHaveProperty("input");
    expect(checkpoints[2]?.pendingToolCall).not.toHaveProperty("output");
  });

  it("stops for manual recovery when resuming from a pending tool checkpoint", async () => {
    const host = createInMemoryExecutionHost();
    const pendingToolCall: RuntimeToolExecutionCheckpoint = {
      attempt: 1,
      idempotencyKey: "run-1:call-tool-1",
      input: {},
      policy: "manual-recovery",
      toolCallId: "call-tool-1",
      toolName: "dangerous_tool",
    };
    const model = createScriptedModelOptions([
      [assistantMessage("SHOULD NOT RUN")],
    ]);
    await host.store.runs.create(createQueuedUserTurnRun());
    await host.store.checkpoints.append(
      {
        checkpointId: "pending-tool",
        pendingToolCall,
        phase: "before-tool",
        runId: "run-1",
        runtimeState: { step: 1 },
        threadSnapshot: { history: [] },
        version: 1,
      },
      { expectedVersion: 0 }
    );

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        model,
        loadState: () => Promise.resolve({ history: [] }),
        runId: "run-1",
        saveState: () => Promise.resolve(),
      })
    ).rejects.toBeInstanceOf(ToolExecutionNeedsRecoveryError);
    expect(model.model.doGenerateCalls).toHaveLength(0);
  });
});
