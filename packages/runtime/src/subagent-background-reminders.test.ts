import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectRun,
  drainRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  lastGenerateTextTools,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import {
  assistantMessage,
  notifyRuntimeInput,
  researcherSubagent,
  toolCallPart,
  userText,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("subagent background reminders", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose background child session keys", async () => {
    const Agent = await loadAgent();
    const childGate = new Promise<void>(() => undefined);
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => {
            await childGate;
            return [assistantMessage("CHILD DONE")];
          },
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const first = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research first", run_in_background: true },
      toolExecutionOptions()
    )) as Record<string, unknown>;
    const second = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research second", run_in_background: true },
      toolExecutionOptions()
    )) as Record<string, unknown>;

    expect(first).toHaveProperty("task_id");
    expect(second).toHaveProperty("task_id");
    expect(first).not.toHaveProperty("sessionKey");
    expect(second).not.toHaveProperty("sessionKey");
    expect(first.task_id).not.toBe(second.task_id);
  });

  it("does not enqueue completion reminders when the active job limit is full", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: ({ signal }) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => resolve([]), {
                once: true,
              });
            }),
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const launches: { status: string; task_id: string }[] = [];
    for (let index = 0; index < 65; index += 1) {
      launches.push(
        (await executableTool(tools, "delegate_to_researcher").execute?.(
          { prompt: `research ${index}`, run_in_background: true },
          toolExecutionOptions()
        )) as { status: string; task_id: string }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      executableTool(tools, "background_output").execute?.(
        { task_id: launches[0]?.task_id ?? "" },
        toolExecutionOptions()
      )
    ).resolves.toEqual(expect.objectContaining({ status: "running" }));
    expect(launches.at(-1)).toEqual(
      expect.objectContaining({ status: "cancelled" })
    );

    const events = await collectRun(await agent.send(userText("continue")));
    const serializedEvents = JSON.stringify(events);

    expect(serializedEvents).not.toContain(launches[0]?.task_id);
  });

  it("injects compact background completion reminder", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [assistantMessage("CHILD DONE")],
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      {
        description: "Research facts",
        prompt: "research this",
        run_in_background: true,
      },
      toolExecutionOptions()
    )) as { task_id: string };
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = await collectRun(await agent.send(userText("continue")));
    const reminder = events.find((event) => event.type === "runtime-input");
    const reminderText =
      reminder?.type === "runtime-input" && reminder.input.type === "user-text"
        ? reminder.input.text
        : "";

    expect(reminder).toEqual(
      expect.objectContaining({
        ...notifyRuntimeInput("", "turn-start"),
        input: {
          ...notifyRuntimeInput("", "turn-start").input,
          text: expect.stringContaining(
            `Use background_output({ task_id: "${launch.task_id}" })`
          ),
        },
      })
    );
    expect(reminderText).toEqual(
      expect.stringContaining("[SUBAGENT JOB RESULT READY]")
    );
    expect(reminderText).toEqual(
      expect.stringContaining(`Task ID: ${launch.task_id}`)
    );
    expect(reminderText).toEqual(
      expect.stringContaining("Subagent: researcher")
    );
    expect(reminderText).toEqual(
      expect.stringContaining("Description: Research facts")
    );
    expect(JSON.stringify(reminder)).not.toContain("CHILD DONE");
  });

  it("lets the parent retrieve a ready background result with background_output", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [assistantMessage("CHILD DONE")],
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      {
        description: "Research facts",
        prompt: "research this",
        run_in_background: true,
      },
      toolExecutionOptions()
    )) as { task_id: string };
    await new Promise((resolve) => setTimeout(resolve, 20));

    const toolCall = toolCallPart(
      "call-background-output",
      "background_output",
      {
        task_id: launch.task_id,
      }
    );
    generateTextMock.mockImplementationOnce(
      async ({
        messages,
        tools: nextTools,
      }: {
        messages: unknown;
        tools?: ToolSet;
      }) => {
        const serializedMessages = JSON.stringify(messages);
        expect(serializedMessages).toContain("[SUBAGENT JOB RESULT READY]");
        expect(serializedMessages).toContain(launch.task_id);
        const output = await nextTools?.background_output?.execute?.(
          { task_id: launch.task_id },
          toolExecutionOptions()
        );

        return {
          responseMessages: [
            assistantMessage([toolCall]),
            {
              content: [
                {
                  output: { type: "json", value: output },
                  toolCallId: "call-background-output",
                  toolName: "background_output",
                  type: "tool-result",
                },
              ],
              role: "tool",
            },
            assistantMessage("USED CHILD DONE"),
          ],
        };
      }
    );

    const events = await collectRun(await agent.send(userText("continue")));
    const serializedEvents = JSON.stringify(events);

    expect(serializedEvents).toContain('"toolName":"background_output"');
    expect(serializedEvents).toContain("CHILD DONE");
    expect(serializedEvents).toContain("USED CHILD DONE");
  });

  it("does not inject full child trace into parent context", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [assistantMessage("CHILD TRACE SECRET")],
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    await executableTool(tools, "delegate_to_researcher").execute?.(
      {
        description: "Trace should stay out of parent context",
        prompt: "research this",
        run_in_background: true,
      },
      toolExecutionOptions()
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = await collectRun(await agent.send(userText("continue")));
    const runtimeInput = events.find((event) => event.type === "runtime-input");
    const serializedEvents = JSON.stringify(events);

    expect(runtimeInput).toBeDefined();
    expect(serializedEvents).toContain("[SUBAGENT JOB RESULT READY]");
    expect(serializedEvents).not.toContain("CHILD TRACE SECRET");
    expect(serializedEvents).not.toContain('"events"');
  });
});
