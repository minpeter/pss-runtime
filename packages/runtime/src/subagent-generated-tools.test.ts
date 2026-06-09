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
import {
  assistantMessage,
  researcherSubagent,
  userText,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();
const backgroundStatusPattern = /^(pending|running|completed)$/;
const backgroundTaskIdPattern = /^bg_/;

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

  it("uses custom delegateToolName when provided", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          delegateToolName: "sendmessageto_agent",
          description: "Executes tasks for the parent.",
          model: async () => [assistantMessage("EXEC DONE")],
          name: "execution",
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual([
      "background_cancel",
      "background_output",
      "sendmessageto_agent",
    ]);
    expect(tools).not.toHaveProperty("delegate_to_execution");
  });

  it("wraps delegate prompts when a child plugin intercepts delegate source", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          description: "Executes tasks for the parent.",
          model: ({ history }) => {
            childHistories.push(history);
            return Promise.resolve([assistantMessage("EXEC DONE")]);
          },
          name: "execution",
          plugins: [
            {
              on: ({ event }) => {
                if (
                  event.type !== "user-text" ||
                  event.meta?.source !== "delegate" ||
                  typeof event.text !== "string"
                ) {
                  return;
                }
                return {
                  action: "transform",
                  event: { ...event, text: `<poke>${event.text}</poke>` },
                };
              },
            },
          ],
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_execution"
    ).execute?.({ prompt: "find my todos" }, toolExecutionOptions());

    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "<poke>find my todos</poke>"
    );
  });

  it("passes generated delegate and background tools to model", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [],
        }),
      ],
    });

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
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [assistantMessage("CHILD DONE")],
        }),
      ],
    });

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
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [assistantMessage("CHILD DONE")],
        }),
      ],
    });

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

  it("background delegation launches background work when run_in_background is true", async () => {
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

    const output = await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
      toolExecutionOptions()
    );

    expect(output).toEqual(
      expect.objectContaining({
        run_in_background: true,
        status: expect.stringMatching(backgroundStatusPattern),
        subagent: "researcher",
        task_id: expect.stringMatching(backgroundTaskIdPattern),
      })
    );
  });

  it("explicit blocking delegation remains available when background tools are available", async () => {
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

    const output = await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: false },
      toolExecutionOptions()
    );

    expect(output).toEqual(
      expect.objectContaining({
        result: "completed",
        run_in_background: false,
        text: "CHILD DONE",
      })
    );
  });

  it("background-only delegation launches background work when run_in_background is omitted", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          delegationMode: "background-only",
          model: async () => [assistantMessage("CHILD DONE")],
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    const output = await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "research this" }, toolExecutionOptions());

    expect(output).toEqual(
      expect.objectContaining({
        run_in_background: true,
        status: expect.stringMatching(backgroundStatusPattern),
        subagent: "researcher",
        task_id: expect.stringMatching(backgroundTaskIdPattern),
      })
    );
  });

  it("background-only delegation rejects explicit blocking downgrade", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          delegationMode: "background-only",
          model: async () => [assistantMessage("CHILD DONE")],
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    await expect(
      executableTool(
        lastGenerateTextTools(),
        "delegate_to_researcher"
      ).execute?.(
        { prompt: "research this", run_in_background: false },
        toolExecutionOptions()
      )
    ).rejects.toThrow(
      "Blocking subagent delegation is not available for this tool."
    );
  });

  it("blocking delegation uses parent-scoped child session key", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: ({ history }) => {
            childHistories.push(history);
            return Promise.resolve([assistantMessage("CHILD DONE")]);
          },
        }),
      ],
    });

    await drainRun(await agent.session("parent-a").send(userText("delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "research this" }, toolExecutionOptions());
    expect(JSON.stringify(childHistories.at(-1))).toContain("research this");
  });

  it("isolates shared subagent sessions between parent agents", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = researcherSubagent({
      model: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
    });
    const firstAgent = new Agent({ model: fakeModel, subagents: [researcher] });
    const secondAgent = new Agent({
      model: fakeModel,
      subagents: [researcher],
    });

    await drainRun(await firstAgent.send(userText("first delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "first child work" }, toolExecutionOptions());
    await drainRun(await secondAgent.send(userText("second delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "second child work" }, toolExecutionOptions());

    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "second child work"
    );
    expect(JSON.stringify(childHistories.at(-1))).not.toContain(
      "first child work"
    );
  });

  it("blocking delegation uses provided session key suffix", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: ({ history }) => {
            childHistories.push(history);
            return Promise.resolve([assistantMessage("CHILD DONE")]);
          },
        }),
      ],
    });

    await drainRun(await agent.session("parent-a").send(userText("delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research custom", sessionKey: "custom-child-session" },
      toolExecutionOptions()
    );
    expect(JSON.stringify(childHistories.at(-1))).toContain("research custom");
  });

  it("namespaces provided child session keys under the parent session", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: ({ history }) => {
            childHistories.push(history);
            return Promise.resolve([assistantMessage("CHILD DONE")]);
          },
        }),
      ],
    });

    await drainRun(await agent.session("parent-a").send(userText("delegate")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research scoped", sessionKey: "custom-child-session" },
      toolExecutionOptions()
    );
    expect(JSON.stringify(childHistories.at(-1))).toContain("research scoped");
  });

  it("exposes a delegate prompt schema that accepts only plain strings", async () => {
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

    const delegate = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    );
    const schema = await (delegate.inputSchema as { jsonSchema: unknown })
      .jsonSchema;

    expect(schema).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          prompt: expect.objectContaining({
            type: "string",
            description: expect.stringContaining("plain string"),
          }),
        }),
      })
    );
    expect(JSON.stringify(schema)).not.toContain("user-text");
    expect(JSON.stringify(schema)).not.toContain("user-message");
  });
});
