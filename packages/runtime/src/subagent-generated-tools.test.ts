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
      model: async () => [],
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
      model: async () => [assistantMessage("CHILD DONE")],
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
      model: async () => [assistantMessage("CHILD DONE")],
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
      model: ({ history }) => {
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
    expect(JSON.stringify(childHistories.at(-1))).toContain("research this");
  });

  it("isolates shared subagent sessions between parent agents", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      model: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
      name: "researcher",
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
    const researcher = new Agent({
      description: "Researches facts.",
      model: ({ history }) => {
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
    expect(JSON.stringify(childHistories.at(-1))).toContain("research custom");
  });

  it("namespaces provided child session keys under the parent session", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      model: ({ history }) => {
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
    expect(JSON.stringify(childHistories.at(-1))).toContain("research scoped");
  });

  it("exposes a delegate prompt schema that rejects malformed content parts", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      model: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

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
            anyOf: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  content: expect.objectContaining({
                    items: expect.any(Object),
                    type: "array",
                  }),
                }),
              }),
              expect.objectContaining({
                items: expect.objectContaining({
                  anyOf: expect.arrayContaining([
                    expect.objectContaining({
                      properties: expect.objectContaining({
                        data: expect.objectContaining({
                          anyOf: expect.any(Array),
                        }),
                      }),
                    }),
                  ]),
                }),
              }),
            ]),
          }),
        }),
      })
    );
    expect(JSON.stringify(schema)).not.toContain('"data":{}');
  });
});
