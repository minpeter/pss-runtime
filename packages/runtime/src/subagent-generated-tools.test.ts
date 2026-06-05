import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  lastGenerateTextTools,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import { assistantMessage, userText } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("generated subagent tools", () => {
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

  it("passes generated delegate and background tools to model", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual([
      "background_cancel",
      "background_output",
      "delegate_to_researcher",
    ]);
    expect(executableTool(tools, "delegate_to_researcher")).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("Researches facts."),
      })
    );
  });

  it("blocking delegation returns compact child text", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const delegate = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    );
    const output = await delegate.execute?.(
      { prompt: "research this" },
      toolExecutionOptions()
    );

    expect(output).toEqual({
      eventCount: expect.any(Number),
      result: "completed",
      run_in_background: false,
      subagent: "researcher",
      text: "CHILD DONE",
    });
    expect(output).not.toHaveProperty("events");
  });

  it("defaults omitted run_in_background to blocking", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const output = await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "research this" }, toolExecutionOptions());

    expect(output).toEqual(
      expect.objectContaining({
        result: "completed",
        run_in_background: false,
        text: "CHILD DONE",
      })
    );
  });

  it("blocking delegation uses parent-scoped child session key", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.session("parent-a").send(userText("delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "research this" }, toolExecutionOptions());
    await drainRun(
      await researcher
        .session("parent:parent-a:subagent:researcher")
        .send(userText("check scoped history"))
    );

    expect(JSON.stringify(childHistories.at(-1))).toContain("research this");
    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "check scoped history"
    );
  });

  it("blocking delegation uses provided session key suffix", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.session("parent-a").send(userText("delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research custom", sessionKey: "custom-child-session" },
      toolExecutionOptions()
    );
    await drainRun(
      await researcher
        .session("parent:parent-a:subagent:researcher:custom-child-session")
        .send(userText("check custom history"))
    );

    expect(JSON.stringify(childHistories.at(-1))).toContain("research custom");
    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "check custom history"
    );
  });

  it("namespaces provided child session keys under the parent session", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.session("parent-a").send(userText("delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research scoped", sessionKey: "custom-child-session" },
      toolExecutionOptions()
    );
    await drainRun(
      await researcher
        .session("parent:parent-a:subagent:researcher:custom-child-session")
        .send(userText("check scoped custom history"))
    );

    expect(JSON.stringify(childHistories.at(-1))).toContain("research scoped");
    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "check scoped custom history"
    );
  });
});
