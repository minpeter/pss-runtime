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
import { ModelToolSelectionError } from "./model-step-preparation";

const generateTextMock = getGenerateTextMock();
const unsupportedApprovalPattern = /needsApproval.*not supported/;
const sha256FingerprintPattern = /sha256:[0-9a-f]{64}/;

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

  it("uses alphabetical tool order by default", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const tools = {
      zeta: createNoopTool(),
      alpha: createNoopTool(),
    } satisfies ToolSet;

    await runModelStep({ model: fakeModel, tools }, { history: [], signal });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: ["alpha", "zeta"],
        toolOrder: ["alpha", "zeta"],
      })
    );
  });

  it("keeps always-active tools as a canonical prefix before dynamic tools", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const history = [{ role: "system" as const, content: "summary" }];
    const tools = {
      zeta: createNoopTool(),
      always_b: createNoopTool(),
      dynamic_b: createNoopTool(),
      always_a: createNoopTool(),
      dynamic_a: createNoopTool(),
    } satisfies ToolSet;
    const seen: unknown[] = [];

    await runModelStep(
      {
        alwaysActiveTools: ["always_b", "always_a"],
        model: fakeModel,
        prepareModelStep: (input) => {
          seen.push(input);
          return {
            activeTools: ["zeta", "dynamic_a"],
            toolChoice: { type: "tool", toolName: "dynamic_a" },
          };
        },
        toolChoice: "required",
        toolOrder: ["always_a", "dynamic_a", "always_b"],
        tools,
      },
      {
        history,
        runtimeStepIndex: 7,
        signal,
        threadKey: "thread-secret",
      }
    );

    expect(seen).toEqual([
      expect.objectContaining({
        history,
        runtimeStepIndex: 7,
        signal,
        threadKey: "thread-secret",
        tools: expect.objectContaining({ zeta: tools.zeta }),
      }),
    ]);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: ["always_a", "always_b", "dynamic_a", "zeta"],
        toolChoice: { type: "tool", toolName: "dynamic_a" },
        toolOrder: ["always_a", "always_b", "dynamic_a", "zeta"],
      })
    );
  });

  it("treats an empty dynamic selection as only always-active tools", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;

    await runModelStep(
      {
        alwaysActiveTools: ["always"],
        model: fakeModel,
        prepareModelStep: () => ({ activeTools: [] }),
        tools: {
          dynamic: createNoopTool(),
          always: createNoopTool(),
        },
      },
      { history: [], signal, threadKey: "thread" }
    );

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: ["always"],
        toolOrder: ["always"],
      })
    );
  });

  it.each([
    {
      label: "an array callback result",
      prepareModelStep: () => [] as never,
      toolChoice: undefined,
    },
    {
      label: "a null callback result",
      prepareModelStep: () => null as never,
      toolChoice: undefined,
    },
    {
      label: "an array model override",
      prepareModelStep: () => ({ model: [] }) as never,
      toolChoice: undefined,
    },
    {
      label: "duplicate dynamic tools",
      prepareModelStep: () => ({ activeTools: ["dynamic", "dynamic"] }),
      toolChoice: undefined,
    },
    {
      label: "unknown dynamic tools",
      prepareModelStep: () => ({ activeTools: ["missing"] }),
      toolChoice: undefined,
    },
    {
      label: "always-active overlap",
      prepareModelStep: () => ({ activeTools: ["always"] }),
      toolChoice: undefined,
    },
    {
      label: "inactive named tool choice",
      prepareModelStep: () => ({ activeTools: [] }),
      toolChoice: { type: "tool" as const, toolName: "dynamic" },
    },
  ])("fails closed for $label", async ({ prepareModelStep, toolChoice }) => {
    const runModelStep = await loadModelStepRunner();

    await expect(
      runModelStep(
        {
          alwaysActiveTools: ["always"],
          model: fakeModel,
          prepareModelStep,
          toolChoice,
          tools: {
            always: createNoopTool(),
            dynamic: createNoopTool(),
          },
        },
        {
          history: [],
          signal: new AbortController().signal,
          threadKey: "thread",
        }
      )
    ).rejects.toMatchObject({ name: ModelToolSelectionError.name });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", ["dynamic", "dynamic"]],
    ["unknown", ["missing"]],
  ] as const)("fails closed for %s configured tool order", async (_label, toolOrder) => {
    const runModelStep = await loadModelStepRunner();

    await expect(
      runModelStep(
        {
          model: fakeModel,
          toolOrder,
          tools: { dynamic: createNoopTool() },
        },
        { history: [], signal: new AbortController().signal }
      )
    ).rejects.toMatchObject({ name: ModelToolSelectionError.name });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("reports only count, index, and hashed tool-name metadata", async () => {
    const runModelStep = await loadModelStepRunner();
    const diagnostics: unknown[] = [];

    await runModelStep(
      {
        diagnostics: {
          report: (diagnostic) => {
            diagnostics.push(diagnostic);
          },
        },
        model: fakeModel,
        prepareModelStep: () => ({ activeTools: ["dynamic_secret"] }),
        tools: { dynamic_secret: createNoopTool() },
      },
      {
        history: [{ content: "raw prompt secret", role: "user" }],
        runtimeStepIndex: 3,
        signal: new AbortController().signal,
        threadKey: "raw-thread-secret",
      }
    );

    await vi.waitFor(() =>
      expect(diagnostics).toEqual([
        {
          code: "model.tool_cache_fingerprint",
          level: "info",
          metadata: expect.objectContaining({
            activeToolCount: 1,
            registeredToolCount: 1,
            runtimeStepIndex: 3,
          }),
          phase: "model-step",
        },
      ])
    );
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("raw prompt secret");
    expect(serialized).not.toContain("raw-thread-secret");
    expect(serialized).not.toContain("dynamic_secret");
    expect(serialized).toMatch(sha256FingerprintPattern);
  });

  it("does not let fingerprint failures block model generation", async () => {
    const runModelStep = await loadModelStepRunner();
    const report = vi.fn();
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(
      new Error("crypto unavailable")
    );

    await expect(
      runModelStep(
        {
          diagnostics: { report },
          model: fakeModel,
          tools: { tool: createNoopTool() },
        },
        { history: [], signal: new AbortController().signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);
    expect(report).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledOnce();
  });

  it("does not await a slow diagnostics sink", async () => {
    const runModelStep = await loadModelStepRunner();
    let markReportStarted: (() => void) | undefined;
    const reportStarted = new Promise<void>((resolve) => {
      markReportStarted = resolve;
    });

    await expect(
      runModelStep(
        {
          diagnostics: {
            report: () => {
              markReportStarted?.();
              return new Promise<void>(() => undefined);
            },
          },
          model: fakeModel,
          tools: { tool: createNoopTool() },
        },
        { history: [], signal: new AbortController().signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);
    await reportStarted;
  });

  it("skips fingerprint work when diagnostics are not configured", async () => {
    const runModelStep = await loadModelStepRunner();
    const digest = vi.spyOn(crypto.subtle, "digest");

    await runModelStep(
      { model: fakeModel, tools: { tool: createNoopTool() } },
      { history: [], signal: new AbortController().signal }
    );

    expect(digest).not.toHaveBeenCalled();
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
