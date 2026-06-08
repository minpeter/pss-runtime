import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkpointedTool,
  createCheckpointSpyHost,
  type GenerateTextToolOptions,
  toolOptions,
} from "./execution-checkpoint-test-support";
import {
  collectRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
} from "./llm-test-utils";
import { assistantMessage, toolCallPart, toolResultFor } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("tool checkpointing through Agent", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("threads execution-host tool checkpoints through high-level Agent", async () => {
    const Agent = await loadAgent();
    const { checkpoints, host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
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
      })
      .mockImplementationOnce(async () => ({
        responseMessages: [assistantMessage("DONE")],
      }));

    const agent = new Agent({
      host,
      model: fakeModel,
      tools: {
        checkpointed_tool: checkpointedTool("idempotent", () => ({
          ok: true,
        })),
      },
    });

    await collectRun(await agent.send("use the tool"));

    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "before-tool",
      "after-tool",
    ]);
    const [beforeTool, afterTool] = checkpoints;
    expect(beforeTool?.pendingToolCall).toMatchObject({
      idempotencyKey: `${beforeTool?.runId}:call_sdk-tool-call-1`,
      policy: "idempotent",
      toolName: "checkpointed_tool",
    });
    expect(afterTool?.pendingToolCall).toMatchObject({
      output: { ok: true },
      toolCallId: "call_sdk-tool-call-1",
      toolName: "checkpointed_tool",
    });
    await expect(
      host.store.runs.get(beforeTool?.runId ?? "")
    ).resolves.toMatchObject({
      checkpointVersion: 2,
      kind: "user-turn",
      status: "completed",
    });
  });
});
