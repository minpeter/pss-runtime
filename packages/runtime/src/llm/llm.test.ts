import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoopTool,
  drainRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  loadModelStepRunner,
} from "../testing/llm-test-utils";
import { assistantMessage } from "../testing/test-fixtures";

const generateTextMock = getGenerateTextMock();
const unsupportedApprovalPattern = /needsApproval.*not supported/;

describe("generateModelStep", () => {
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

  it("passes injected tools to generateText", async () => {
    const runModelStep = await loadModelStepRunner();
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];

    await expect(
      runModelStep(
        {
          instructions: "test instructions",
          model: fakeModel,
          tools: injectedTools,
        },
        { history, signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: signal,
        instructions: "test instructions",
        messages: history,
        model: fakeModel,
        tools: expect.objectContaining({
          injected: expect.any(Object),
        }),
      })
    );
  });

  it("hoists system history into instructions for provider-compatible prompts", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const messages = [{ role: "user" as const, content: "tail" }];

    await expect(
      runModelStep(
        {
          instructions: "base",
          model: fakeModel,
        },
        {
          history: [
            { role: "system", content: "compacted context" },
            ...messages,
          ],
          signal,
        }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "base\n\ncompacted context",
        messages,
      })
    );
  });

  it("passes configured toolChoice to generateText", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];

    await expect(
      runModelStep(
        {
          model: fakeModel,
          toolChoice: "required",
        },
        { history, signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: "required",
      })
    );
  });

  it("passes a configured named toolChoice to generateText", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const tools = { injected: createNoopTool() } satisfies ToolSet;
    const toolChoice = { type: "tool", toolName: "injected" } as const;

    await expect(
      runModelStep(
        {
          model: fakeModel,
          toolChoice,
          tools,
        },
        { history, signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice,
      })
    );
  });

  it("rejects tools using AI SDK tool approval before generateText", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const tools = {
      risky: {
        ...createNoopTool(),
        needsApproval: true,
      },
    } satisfies ToolSet;

    await expect(
      runModelStep(
        {
          model: fakeModel,
          tools,
        },
        { history, signal }
      )
    ).rejects.toThrow(unsupportedApprovalPattern);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("Agent tool wiring", () => {
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

  it("passes injected AgentOptions tools into generateText", async () => {
    const Agent = await loadAgent();
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
    const agent = new Agent({
      model: fakeModel,
      tools: injectedTools,
    });

    await drainRun(await agent.send("use injected tools"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        tools: expect.objectContaining({
          injected: expect.any(Object),
        }),
      })
    );
  });

  it("passes AgentOptions toolChoice into generateText", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      toolChoice: "required",
    });

    await drainRun(await agent.send("force tool choice"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        toolChoice: "required",
      })
    );
  });

  it("does not attach product tools by default", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({ model: fakeModel });

    await drainRun(await agent.send("run without product tools"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      })
    );
  });
});
