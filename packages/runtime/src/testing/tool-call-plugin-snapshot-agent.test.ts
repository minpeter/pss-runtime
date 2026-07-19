import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePlugin } from "../plugins/api";
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
} from "./llm-test-utils";
import { assistantMessage, toolCallPart, toolResultFor } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

interface MutableNestedInput {
  readonly payload: {
    path: string;
  };
}

function isMutableNestedInput(value: unknown): value is MutableNestedInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "payload" in value &&
    typeof value.payload === "object" &&
    value.payload !== null &&
    "path" in value.payload &&
    typeof value.payload.path === "string"
  );
}

describe("tool-call plugin snapshots through Agent", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps plugin input mutations out of tool execution", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    let executedInput: unknown;

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart("call_sdk-tool-call-1", "checked_tool");
        await executableTool(options.tools ?? {}, "checked_tool").execute?.(
          { payload: { path: "README.md" } },
          toolOptions("call_sdk-tool-call-1", signal)
        );

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

    const mutationPlugin = definePlugin((pss) => {
      pss.on("tool.call.before", (event) => {
        if (isMutableNestedInput(event.input)) {
          event.input.payload.path = "MUTATED.md";
        }
        return { action: "continue" };
      });
    });

    const agent = await createAgent({
      host,
      model: fakeModel,
      plugins: [mutationPlugin],
      tools: {
        checked_tool: checkpointedTool("idempotent", (input) => {
          executedInput = input;
          return { ok: true };
        }),
      },
    });

    await collectRun(await agent.send("use the tool"));

    expect(executedInput).toEqual({
      payload: { path: "README.md" },
    });
  });

  it("keeps tool.call.before events out of public turn events", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    const interceptedToolNames: string[] = [];

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart("call_sdk-tool-call-1", "checked_tool");
        await executableTool(options.tools ?? {}, "checked_tool").execute?.(
          { payload: { path: "README.md" } },
          toolOptions("call_sdk-tool-call-1", signal)
        );

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

    const observerPlugin = definePlugin((pss) => {
      pss.on("tool.call.before", (event) => {
        interceptedToolNames.push(event.toolName);
        return { action: "continue" };
      });
    });

    const agent = await createAgent({
      host,
      model: fakeModel,
      plugins: [observerPlugin],
      tools: {
        checked_tool: checkpointedTool("idempotent", () => ({ ok: true })),
      },
    });

    const events = await collectRun(await agent.send("use the tool"));

    expect(interceptedToolNames).toEqual(["checked_tool"]);
    expect(events.map((event) => event.type)).not.toContain("tool.call.before");
  });
});
