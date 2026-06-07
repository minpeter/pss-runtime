import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoopTool,
  drainRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  loadCreateLlm,
} from "./llm-test-utils";
import { assistantMessage, userText } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("createLlm", () => {
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
    const createLlm = await loadCreateLlm();
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const llm = createLlm({
      instructions: "test instructions",
      model: fakeModel,
      tools: injectedTools,
    });

    await expect(llm({ history, signal })).resolves.toEqual([
      assistantMessage("DONE"),
    ]);

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

  it("passes configured toolChoice to generateText", async () => {
    const createLlm = await loadCreateLlm();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const llm = createLlm({
      model: fakeModel,
      toolChoice: "required",
    });

    await expect(llm({ history, signal })).resolves.toEqual([
      assistantMessage("DONE"),
    ]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: "required",
      })
    );
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

  it("passes injected AgentOptions tools into createLlm/generateText", async () => {
    const Agent = await loadAgent();
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
    const agent = new Agent({
      model: fakeModel,
      tools: injectedTools,
    });

    await drainRun(await agent.send(userText("use injected tools")));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        tools: expect.objectContaining({
          injected: expect.any(Object),
        }),
      })
    );
  });

  it("passes AgentOptions toolChoice into createLlm/generateText", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      toolChoice: "required",
    });

    await drainRun(await agent.send(userText("force tool choice")));

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

    await drainRun(await agent.send(userText("run without product tools")));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      })
    );
  });
});
