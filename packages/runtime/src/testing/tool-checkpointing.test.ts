import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryExecutionHost } from "../execution/memory";
import type { RuntimeToolExecutionCheckpoint } from "../llm/llm";
import {
  checkpointedTool,
  createQueuedUserTurnRun,
  type GenerateTextToolOptions,
  toolOptions,
} from "./execution-checkpoint-test-support";
import {
  executableTool,
  fakeModel,
  getGenerateTextMock,
  loadModelStepRunner,
} from "./llm-test-utils";
import { assistantMessage, toolCallPart, toolResultFor } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("tool checkpointing", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists before-tool before executing idempotent tool", async () => {
    const runModelStep = await loadModelStepRunner();
    const host = createInMemoryExecutionHost();
    const order: string[] = [];
    const signal = new AbortController().signal;
    await host.store.turns.create(createQueuedUserTurnRun());

    generateTextMock.mockImplementationOnce(
      async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart(
          "call_sdk-tool-call-1",
          "checkpointed_tool"
        );
        await executableTool(
          options.tools ?? {},
          "checkpointed_tool"
        ).execute?.({}, toolOptions("call_sdk-tool-call-1", signal));

        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      }
    );

    await expect(
      runModelStep(
        {
          model: fakeModel,
          tools: {
            checkpointed_tool: checkpointedTool("idempotent", async () => {
              order.push("execute");
              await expect(
                host.store.checkpoints.latest("run-1")
              ).resolves.toMatchObject({
                phase: "before-tool",
                pendingToolCall: expect.objectContaining({
                  idempotencyKey: "run-1:call_sdk-tool-call-1",
                  policy: "idempotent",
                  toolName: "checkpointed_tool",
                }),
              });
              return {};
            }),
          },
        },
        {
          history: [],
          signal,
          toolExecution: {
            attempt: 2,
            beforeTool: async (checkpoint: RuntimeToolExecutionCheckpoint) => {
              order.push("before-tool");
              await host.store.checkpoints.append(
                {
                  checkpointId: "checkpoint-before-tool",
                  pendingToolCall: checkpoint,
                  phase: "before-tool",
                  runId: "run-1",
                  runtimeState: {},
                  threadSnapshot: {},
                  version: 1,
                },
                { expectedVersion: 0 }
              );
            },
            runId: "run-1",
          },
        }
      )
    ).resolves.toHaveLength(2);

    expect(order).toEqual(["before-tool", "execute"]);
  });

  it("manual recovery tool is not retried after rollback", async () => {
    const runModelStep = await loadModelStepRunner();
    const host = createInMemoryExecutionHost();
    const signal = new AbortController().signal;
    let executions = 0;
    await host.store.turns.create({
      ...createQueuedUserTurnRun(),
      checkpointVersion: 1,
    });
    await host.store.checkpoints.append(
      {
        checkpointId: "previous-before-tool",
        pendingToolCall: {
          idempotencyKey: "run-1:call_sdk-tool-call-1",
          policy: "manual-recovery",
          toolCallId: "call_sdk-tool-call-1",
          toolName: "dangerous_tool",
        },
        phase: "before-tool",
        runId: "run-1",
        runtimeState: {},
        threadSnapshot: {},
        version: 1,
      },
      { expectedVersion: 1 }
    );

    generateTextMock.mockImplementationOnce(
      async (options: GenerateTextToolOptions) => {
        await executableTool(options.tools ?? {}, "dangerous_tool").execute?.(
          {},
          toolOptions("call_sdk-tool-call-1", signal)
        );

        return {
          responseMessages: [assistantMessage("SHOULD NOT FINISH")],
        };
      }
    );

    await expect(
      runModelStep(
        {
          model: fakeModel,
          tools: {
            dangerous_tool: checkpointedTool("manual-recovery", () => {
              executions += 1;
              return {};
            }),
          },
        },
        {
          history: [],
          signal,
          toolExecution: {
            attempt: 2,
            beforeTool: async () => ({ status: "needs-recovery" }),
            runId: "run-1",
          },
        }
      )
    ).rejects.toMatchObject({
      status: "needs-recovery",
      toolName: "dangerous_tool",
    });
    expect(executions).toBe(0);
  });
});
