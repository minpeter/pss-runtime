import type { LanguageModel, Tool, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMessage, createDeferred, userText } from "./test-fixtures";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();

  return {
    ...actual,
    generateText: generateTextMock,
  };
});

const fakeModel = {} as LanguageModel;

async function loadAgent() {
  const { Agent } = await import("./agent");
  return Agent;
}

async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  let drained = 0;
  for await (const _event of run.events()) {
    drained += 1;
  }
  return drained;
}

function lastGenerateTextTools(): ToolSet {
  const call = generateTextMock.mock.calls.at(-1)?.[0] as
    | { tools?: ToolSet }
    | undefined;
  return call?.tools ?? {};
}

function executableTool(tools: ToolSet, name: string): Tool {
  const candidate = tools[name];
  expect(candidate).toBeDefined();
  expect(candidate?.execute).toBeTypeOf("function");
  return candidate as Tool;
}

function toolExecutionOptions(signal = new AbortController().signal) {
  return {
    abortSignal: signal,
    context: undefined,
    messages: [],
    toolCallId: "call-1",
  };
}

describe("subagent hardening", () => {
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

  it("interrupts blocking subagent delegation when the parent tool aborts", async () => {
    const Agent = await loadAgent();
    const childStarted = createDeferred();
    const childAborted = createDeferred();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ signal }) =>
        new Promise((resolve) => {
          childStarted.resolve();
          signal.addEventListener(
            "abort",
            () => {
              childAborted.resolve();
              resolve([assistantMessage("CHILD ABORTED")]);
            },
            { once: true }
          );
        }),
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });
    const abort = new AbortController();

    await drainRun(await agent.send(userText("delegate")));
    const outputPromise = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this" },
      toolExecutionOptions(abort.signal)
    );
    await childStarted.promise;
    abort.abort();

    await expect(outputPromise).resolves.toEqual(
      expect.objectContaining({
        result: "aborted",
      })
    );
    await expect(childAborted.promise).resolves.toBeUndefined();
  });

  it("does not start background child work when the tool signal is already aborted", async () => {
    const Agent = await loadAgent();
    let childStarts = 0;
    const researcher = new Agent({
      description: "Researches facts.",
      llm: () => {
        childStarts += 1;
        return Promise.resolve([assistantMessage("SHOULD NOT START")]);
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });
    const abort = new AbortController();
    abort.abort();

    await drainRun(await agent.send(userText("delegate")));
    const output = await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
      toolExecutionOptions(abort.signal)
    );

    expect(output).toEqual(
      expect.objectContaining({
        run_in_background: true,
        status: "cancelled",
      })
    );
    expect(childStarts).toBe(0);
  });

  it("rejects malformed delegate prompts before child sessions receive them", async () => {
    const Agent = await loadAgent();
    let childStarts = 0;
    const researcher = new Agent({
      description: "Researches facts.",
      llm: () => {
        childStarts += 1;
        return Promise.resolve([assistantMessage("SHOULD NOT START")]);
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    await expect(
      executableTool(
        lastGenerateTextTools(),
        "delegate_to_researcher"
      ).execute?.({ prompt: 123 }, toolExecutionOptions())
    ).rejects.toThrow("Agent input must be text");
    expect(childStarts).toBe(0);
  });
});
