import { jsonSchema, type Tool, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createAgent } from "../agent/core/agent";
import { createInMemoryHost } from "../platform/memory";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
  createScriptedModelOptions,
  sentUserText,
  toolCallPart,
  toolResultFor,
} from "../testing/test-fixtures";
import { collect } from "../thread/handle/test-support";
import { definePlugin, historyPolicy, registerTool, threadScope } from "./api";
import {
  PluginHookError,
  PluginInitializationError,
  PluginRegistrationClosedError,
  PluginRuntime,
} from "./runtime";

describe("factory plugin API", () => {
  it("names plugin tool capabilities without colliding with AI SDK tool", () => {
    const definition = {} as Tool;

    expect(
      registerTool({ name: "example_tool", tool: definition })
    ).toMatchObject({
      kind: "tool",
      name: "example_tool",
      tool: definition,
    });
  });

  it("returns the supplied factory", () => {
    const factory = () => undefined;

    expect(definePlugin(factory)).toBe(factory);
  });

  it("awaits factories in registration order", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = definePlugin(async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    const second = definePlugin(() => {
      order.push("second");
    });
    const creating = PluginRuntime.create([first, second], {
      diagnostics: { report: () => undefined },
      factoryTimeoutMs: 1000,
      hookTimeoutMs: 1000,
    });

    expect(order).toEqual(["first:start"]);
    releaseFirst?.();
    const runtime = await creating;

    expect(order).toEqual(["first:start", "first:end", "second"]);
    await runtime.dispose();
  });

  it("chains input transforms", async () => {
    const plugin = definePlugin(async (pss) => {
      await Promise.resolve();
      pss.on("input.accept", (event) => {
        if (!("text" in event && typeof event.text === "string")) {
          return;
        }
        return {
          action: "transform",
          value: { ...event, text: `factory:${event.text}` },
        };
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [plugin],
    });

    const events = await collect(await agent.send("hello"));
    expect(events[0]).toEqual(sentUserText("factory:hello"));
  });

  it("lets input hooks handle a send before a turn starts", async () => {
    const seen: string[] = [];
    const plugin = definePlugin((pss) => {
      pss.on("input.accept", () => ({ action: "handled" }));
      pss.on("turn.start", () => {
        seen.push("turn.start");
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("UNREACHABLE")])
      ),
      plugins: [plugin],
    });

    const events = await collect(await agent.send("handled"));

    expect(events).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("isolates thread-scoped state", async () => {
    const seen: number[] = [];
    const plugin = definePlugin((pss) => {
      const state = pss.provide(threadScope(() => ({ count: 0 })));
      pss.on("input.accept", (_event, context) => {
        const value = state.get(context.thread);
        value.count += 1;
        seen.push(value.count);
        return { action: "continue" };
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [plugin],
    });

    await collect(await agent.thread("one").send("a"));
    await collect(await agent.thread("one").send("b"));
    await collect(await agent.thread("two").send("c"));
    expect(seen).toEqual([1, 2, 1]);
  });

  it("creates an undefined thread-scoped value only once per thread", async () => {
    let creates = 0;
    const plugin = definePlugin((pss) => {
      const state = pss.provide(
        threadScope(() => {
          creates += 1;
          return;
        })
      );
      pss.on("input.accept", (_event, context) => {
        state.get(context.thread);
        state.get(context.thread);
        return { action: "continue" };
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [plugin],
    });

    await collect(await agent.thread("one").send("a"));
    await collect(await agent.thread("one").send("b"));
    await collect(await agent.thread("two").send("c"));

    expect(creates).toBe(2);
  });

  it("dispatches the complete lifecycle in deterministic order", async () => {
    const seen: string[] = [];
    const plugin = definePlugin((pss) => {
      pss.on("thread.start", (_event, context) => {
        seen.push(`thread.start:${context.thread.key}`);
      });
      pss.on("input.accept", () => {
        seen.push("input.accept");
        return { action: "continue" };
      });
      pss.on("turn.start.before", () => {
        seen.push("turn.start.before");
        return { action: "continue" };
      });
      for (const event of [
        "turn.start",
        "step.start",
        "message.start",
        "message.update",
        "message.end",
        "step.end",
        "turn.end",
        "turn.settled",
        "thread.shutdown",
      ] as const) {
        pss.on(event, () => {
          seen.push(event);
        });
      }
      pss.on("provider.request.before", () => {
        seen.push("provider.request.before");
        return { action: "continue" };
      });
      pss.on("provider.response.after", () => {
        seen.push("provider.response.after");
      });
      pss.on("model.context", () => {
        seen.push("model.context");
        return { action: "continue" };
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [plugin],
    });

    await collect(await agent.thread("lifecycle").send("hello"));
    await agent.dispose();

    expect(seen).toEqual([
      "thread.start:lifecycle",
      "input.accept",
      "turn.start.before",
      "turn.start",
      "step.start",
      "model.context",
      "provider.request.before",
      "provider.response.after",
      "message.start",
      "message.update",
      "message.end",
      "step.end",
      "turn.end",
      "turn.settled",
      "thread.shutdown",
    ]);
  });

  it("applies provider request transforms before generation", async () => {
    const temperatures: Array<number | undefined> = [];
    const model = createMockLanguageModelV4((params) => {
      temperatures.push(params.temperature);
      return Promise.resolve(mockLanguageModelV4Text("DONE"));
    });
    const plugin = definePlugin((pss) => {
      pss.on("provider.request.before", ({ params }) => ({
        action: "transform",
        value: { params: { ...params, temperature: 0.25 } },
      }));
    });
    const agent = await createAgent({ model, plugins: [plugin] });

    await collect(await agent.send("hello"));

    expect(temperatures).toEqual([0.25]);
  });

  it("blocks a tool call without executing the tool", async () => {
    const call = toolCallPart("call-blocked", "dangerous_tool");
    const model = createScriptedModelOptions([
      [assistantMessage([call]), toolResultFor(call)],
      [assistantMessage("DONE")],
    ]);
    let executions = 0;
    model.tools = {
      dangerous_tool: tool({
        execute: () => {
          executions += 1;
          return { ok: true };
        },
        inputSchema: jsonSchema({
          additionalProperties: false,
          properties: {},
          type: "object",
        }),
      }),
    };
    const phases: string[] = [];
    const plugin = definePlugin((pss) => {
      pss.on("tool.call.before", () => {
        phases.push("tool.call.before");
        return { action: "block", reason: "not allowed" };
      });
      pss.on("tool.execution.start", () => {
        phases.push("tool.execution.start");
      });
      pss.on("tool.execution.end", () => {
        phases.push("tool.execution.end");
      });
    });
    const agent = await createAgent({ ...model, plugins: [plugin] });

    const events = await collect(await agent.send("run it"));

    expect(executions).toBe(0);
    expect(phases).toEqual(["tool.call.before"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        output: expect.objectContaining({
          value: expect.objectContaining({ blocked: true }),
        }),
        type: "tool-result",
      })
    );
  });

  it("marks a tool call for recovery without executing it", async () => {
    const call = toolCallPart("call-recovery", "dangerous_tool");
    const model = createScriptedModelOptions([
      [assistantMessage([call]), toolResultFor(call)],
    ]);
    let executions = 0;
    model.tools = {
      dangerous_tool: tool({
        execute: () => {
          executions += 1;
          return { ok: true };
        },
        inputSchema: jsonSchema({
          additionalProperties: false,
          properties: {},
          type: "object",
        }),
      }),
    };
    const plugin = definePlugin((pss) => {
      pss.on("tool.call.before", () => ({ action: "needs-recovery" }));
    });
    const agent = await createAgent({ ...model, plugins: [plugin] });

    const events = await collect(await agent.send("run it"));

    expect(executions).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn-error" })
    );
  });

  it("transforms tool results before they return to the model", async () => {
    const call = toolCallPart("call-transform", "lookup");
    const model = createScriptedModelOptions([
      [assistantMessage([call]), toolResultFor(call)],
      [assistantMessage("DONE")],
    ]);
    const phases: string[] = [];
    const plugin = definePlugin((pss) => {
      pss.on("tool.call.before", () => {
        phases.push("tool.call.before");
        return { action: "continue" };
      });
      pss.on("tool.execution.start", () => {
        phases.push("tool.execution.start");
      });
      pss.on("tool.result", (event) => {
        phases.push("tool.result");
        return {
          action: "transform",
          value: { ...event, output: { transformed: true } },
        };
      });
      pss.on("tool.execution.end", (event) => {
        phases.push("tool.execution.end");
        expect(event.output).toEqual({ transformed: true });
      });
    });
    const agent = await createAgent({ ...model, plugins: [plugin] });

    const events = await collect(await agent.send("look up"));

    expect(phases).toEqual([
      "tool.call.before",
      "tool.execution.start",
      "tool.result",
      "tool.execution.end",
    ]);
    expect(JSON.stringify(events)).toContain("transformed");
  });

  it("transforms and reports compaction, and can cancel it", async () => {
    const compacted: string[] = [];
    let cancel = false;
    const plugin = definePlugin((pss) => {
      pss.on("thread.compaction.before", ({ input }) => {
        if (cancel) {
          return { action: "cancel" };
        }
        return {
          action: "transform",
          value: { input: { ...input, summary: `guarded:${input.summary}` } },
        };
      });
      pss.on("thread.compaction.after", ({ input }) => {
        compacted.push(input.summary);
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [plugin],
    });
    const thread = agent.thread("compact");
    await collect(await thread.send("hello"));

    await thread.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "first",
    });
    cancel = true;
    await thread.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "second",
    });

    expect(compacted).toEqual(["guarded:first"]);
  });

  it("chains model context transforms before model generation", async () => {
    const seen: unknown[] = [];
    const first = definePlugin((pss) => {
      pss.on("model.context", ({ messages }) => ({
        action: "transform",
        value: {
          messages: [{ content: "first", role: "system" }, ...messages],
        },
      }));
    });
    const second = definePlugin((pss) => {
      pss.on("model.context", ({ messages }) => ({
        action: "transform",
        value: {
          messages: [{ content: "second", role: "system" }, ...messages],
        },
      }));
    });
    const agent = await createAgent({
      model: createCallbackModel((options) => {
        seen.push(options.history);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
      plugins: [first, second],
    });

    await collect(await agent.send("hello"));

    expect(seen).toEqual([
      [
        { content: "second\n\nfirst", role: "system" },
        expect.objectContaining({ content: "hello", role: "user" }),
      ],
    ]);
  });

  it("applies model context hooks to automatic-compaction model calls", async () => {
    let contextCalls = 0;
    let modelCalls = 0;
    const plugin = definePlugin((pss) => {
      pss.on("model.context", () => {
        contextCalls += 1;
        return { action: "continue" };
      });
    });
    const agent = await createAgent({
      autoCompaction: { minMessages: 4, retainMessages: 2 },
      model: createCallbackModel(() => {
        modelCalls += 1;
        return Promise.resolve([
          assistantMessage(modelCalls === 3 ? "SUMMARY" : "DONE"),
        ]);
      }),
      plugins: [plugin],
    });
    const thread = agent.thread("context-auto-compaction");

    await collect(await thread.send("first"));
    await collect(await thread.send("second"));
    await vi.waitFor(() => expect(modelCalls).toBeGreaterThanOrEqual(3));

    expect(contextCalls).toBe(3);
  });

  it("registers invariant history policies", async () => {
    const plugin = definePlugin((pss) => {
      pss.provide(historyPolicy({}));
    });
    const runtime = await PluginRuntime.create([plugin], {
      diagnostics: { report: () => undefined },
      factoryTimeoutMs: 1000,
      hookTimeoutMs: 1000,
    });

    expect(runtime.canonicalHistoryPolicies).toHaveLength(1);
    await runtime.dispose();
  });

  it("removes a history policy from already-created threads on unsubscribe", async () => {
    let commits = 0;
    let unsubscribe: (() => void) | undefined;
    const plugin = definePlugin((pss) => {
      const subscription = pss.provide(
        historyPolicy({
          beforeCommit: () => {
            commits += 1;
          },
        })
      );
      unsubscribe = () => subscription.unsubscribe();
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [plugin],
    });
    const thread = agent.thread("policy-unsubscribe");
    await collect(await thread.send("first"));
    const commitsBeforeUnsubscribe = commits;

    unsubscribe?.();
    await collect(await thread.send("second"));

    expect(commitsBeforeUnsubscribe).toBeGreaterThan(0);
    expect(commits).toBe(commitsBeforeUnsubscribe);
  });

  it("fails closed with the factory index and cleans up loaded plugins", async () => {
    const diagnostics: unknown[] = [];
    let firstFactoryAborted = false;
    const first = definePlugin((_pss, { signal }) => {
      signal.addEventListener(
        "abort",
        () => {
          firstFactoryAborted = true;
        },
        { once: true }
      );
    });
    const second = definePlugin(() => {
      throw new Error("boom");
    });

    await expect(
      createAgent({
        host: {
          ...createInMemoryHost(),
          diagnostics: {
            report: (event) => {
              diagnostics.push(event);
            },
          },
        },
        model: createCallbackModel(() => Promise.resolve([])),
        plugins: [first, second],
      })
    ).rejects.toMatchObject({
      name: PluginInitializationError.name,
      pluginIndex: 1,
    });
    expect(firstFactoryAborted).toBe(true);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "plugin.factory_failed",
        phase: "factory",
        pluginIndex: 1,
      }),
    ]);
  });

  it("fails closed when a hook throws", async () => {
    const diagnostics: unknown[] = [];
    const runtime = await PluginRuntime.create(
      [
        definePlugin((pss) => {
          pss.on("model.context", () => {
            throw new Error("hook boom");
          });
        }),
      ],
      {
        diagnostics: {
          report: (event) => {
            diagnostics.push(event);
          },
        },
        factoryTimeoutMs: 1000,
        hookTimeoutMs: 1000,
      }
    );

    await expect(
      runtime.transformModelContext("thread", [], [])
    ).rejects.toMatchObject({
      event: "model.context",
      name: PluginHookError.name,
      pluginIndex: 0,
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "plugin.handler_failed",
        event: "model.context",
        phase: "handler",
        pluginIndex: 0,
      }),
    ]);
    await runtime.dispose();
  });

  it("fails closed when a transform result omits its value", async () => {
    const runtime = await PluginRuntime.create(
      [
        definePlugin((pss) => {
          pss.on("model.context", () => ({ action: "transform" }) as never);
        }),
      ],
      {
        diagnostics: { report: () => undefined },
        factoryTimeoutMs: 1000,
        hookTimeoutMs: 1000,
      }
    );

    await expect(
      runtime.transformModelContext("thread", [], [])
    ).rejects.toMatchObject({
      event: "model.context",
      name: PluginHookError.name,
      pluginIndex: 0,
    });
    await runtime.dispose();
  });

  it("dispatches turn.error and turn.settled for runtime failures", async () => {
    const seen: string[] = [];
    const plugin = definePlugin((pss) => {
      pss.on("turn.error", () => {
        seen.push("turn.error");
      });
      pss.on("turn.settled", () => {
        seen.push("turn.settled");
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() => {
        throw new Error("model failed");
      }),
      plugins: [plugin],
    });

    const events = await collect(await agent.send("fail"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn-error" })
    );
    expect(seen).toEqual(["turn.error", "turn.settled"]);
  });

  it("rejects registrations made after the factory completes", async () => {
    let registerLate: (() => void) | undefined;
    const runtime = await PluginRuntime.create(
      [
        definePlugin((pss) => {
          registerLate = () => {
            pss.on("turn.end", () => undefined);
          };
        }),
      ],
      {
        diagnostics: { report: () => undefined },
        factoryTimeoutMs: 1000,
        hookTimeoutMs: 1000,
      }
    );

    expect(registerLate).toBeDefined();
    expect(() => registerLate?.()).toThrow(PluginRegistrationClosedError);
    await runtime.dispose();
  });
});
