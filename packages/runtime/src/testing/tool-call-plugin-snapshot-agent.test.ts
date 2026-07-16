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
    const Agent = await loadAgent();
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

    const agent = new Agent({
      host,
      model: fakeModel,
      plugins: [
        {
          on: ({ event }) => {
            if (event.type !== "tool.call.before") {
              return;
            }

            if (isMutableNestedInput(event.input)) {
              event.input.payload.path = "MUTATED.md";
            }
          },
        },
      ],
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
    const Agent = await loadAgent();
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

    const agent = new Agent({
      host,
      model: fakeModel,
      plugins: [
        {
          on: ({ event }) => {
            if (event.type !== "tool.call.before") {
              return;
            }

            interceptedToolNames.push(event.toolName);
          },
        },
      ],
      tools: {
        checked_tool: checkpointedTool("idempotent", () => ({ ok: true })),
      },
    });

    const events = await collectRun(await agent.send("use the tool"));

    expect(interceptedToolNames).toEqual(["checked_tool"]);
    expect(events.map((event) => event.type)).not.toContain("tool.call.before");
  });
});
