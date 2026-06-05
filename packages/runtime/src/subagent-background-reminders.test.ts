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
import { assistantMessage, userText } from "./test-fixtures";

const unknownBackgroundTaskPattern = /Unknown background subagent task/;
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

  it("isolates background child session keys per task", async () => {
    const Agent = await loadAgent();
    const childGate = new Promise<void>(() => undefined);
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => {
        await childGate;
        return [assistantMessage("CHILD DONE")];
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const first = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research first", run_in_background: true },
      toolExecutionOptions()
    )) as { sessionKey: string; task_id: string };
    const second = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research second", run_in_background: true },
      toolExecutionOptions()
    )) as { sessionKey: string; task_id: string };

    expect(first.sessionKey).toContain("parent:default:subagent:researcher");
    expect(second.sessionKey).toContain("parent:default:subagent:researcher");
    expect(first.sessionKey).toContain(first.task_id);
    expect(second.sessionKey).toContain(second.task_id);
    expect(first.sessionKey).not.toBe(second.sessionKey);
  });

  it("does not enqueue completion reminders for pruned background jobs", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve([]), { once: true });
        }),
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const launches: { task_id: string }[] = [];
    for (let index = 0; index < 65; index += 1) {
      launches.push(
        (await executableTool(tools, "delegate_to_researcher").execute?.(
          { prompt: `research ${index}`, run_in_background: true },
          toolExecutionOptions()
        )) as { task_id: string }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      executableTool(tools, "background_output").execute?.(
        { task_id: launches[0]?.task_id ?? "" },
        toolExecutionOptions()
      )
    ).rejects.toThrow(unknownBackgroundTaskPattern);

    const events = await collectRun(await agent.send(userText("continue")));
    const serializedEvents = JSON.stringify(events);

    expect(serializedEvents).not.toContain(launches[0]?.task_id);
  });

  it("injects compact background completion reminder", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

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
        input: {
          text: expect.stringContaining(
            `Use background_output({ task_id: "${launch.task_id}" })`
          ),
          type: "user-text",
        },
        placement: "turn-start",
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

  it("does not inject full child trace into parent context", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD TRACE SECRET")],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

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
