import { jsonSchema, type Tool, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createAgent } from "../agent/core/agent";
import type { ModelStepOutput } from "../llm/llm";
import { createInMemoryHost } from "../platform/memory";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  createScriptedModelOptions,
  sentUserText,
  toolCallPart,
  toolResultFor,
} from "../testing/test-fixtures";
import { collect } from "../thread/handle/test-support";
import { definePlugin, registerTool, threadScope } from "./api";
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

  it("clears thread-scoped state when a shutdown hook fails", async () => {
    const counts: number[] = [];
    const plugin = definePlugin((pss) => {
      const state = pss.provide(threadScope(() => ({ count: 0 })));
      pss.on("input.accept", (_event, context) => {
        const current = state.get(context.thread);
        current.count += 1;
        counts.push(current.count);
        return { action: "continue" };
      });
      pss.on("thread.shutdown", () => {
        throw new Error("shutdown failed");
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [plugin],
    });

    const first = agent.thread("reused");
    await collect(await first.send("one"));
    await expect(first.dispose()).rejects.toThrow("thread.shutdown");
    await collect(await agent.thread("reused").send("two"));

    expect(counts).toEqual([1, 1]);
    await agent.dispose().catch(() => undefined);
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
        "model.usage",
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
      pss.on("model.step.before", () => {
        seen.push("model.step.before");
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
      "model.usage",
      "model.step.before",
      "message.start",
      "message.update",
      "message.end",
      "step.end",
      "turn.end",
      "turn.settled",
      "thread.shutdown",
    ]);
  });

  it("settles an active turn before agent disposal shuts down its thread", async () => {
    const modelStarted = createDeferred();
    const seen: string[] = [];
    const plugin = definePlugin((pss) => {
      for (const event of [
        "turn.start",
        "turn.abort",
        "turn.settled",
        "thread.shutdown",
      ] as const) {
        pss.on(event, () => {
          seen.push(event);
        });
      }
    });
    const agent = await createAgent({
      model: createCallbackModel(
        ({ signal }) =>
          new Promise((resolve) => {
            modelStarted.resolve();
            signal?.addEventListener(
              "abort",
              () => resolve([assistantMessage("IGNORED")]),
              { once: true }
            );
          })
      ),
      plugins: [plugin],
    });

    const collecting = collect(await agent.send("hello"));
    await modelStarted.promise;
    await agent.dispose();
    await collecting;

    expect(seen).toEqual([
      "turn.start",
      "turn.abort",
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

  it("uses model.context as an ephemeral read guard for stored history", async () => {
    const host = createInMemoryHost();
    await host.store.threads.commit(
      "read-guard",
      {
        state: {
          history: [assistantMessage("raw-protocol")],
          schemaVersion: 1,
        },
      },
      { expectedVersion: null }
    );
    const seen: string[] = [];
    const plugin = definePlugin((pss) => {
      pss.on("model.context", ({ messages }) => ({
        action: "transform",
        value: {
          messages: messages.filter(
            (message) => !JSON.stringify(message).includes("raw-protocol")
          ),
        },
      }));
    });
    const agent = await createAgent({
      host,
      model: createCallbackModel(({ history }) => {
        seen.push(JSON.stringify(history));
        return Promise.resolve([assistantMessage("DONE")]);
      }),
      plugins: [plugin],
    });

    await collect(await agent.thread("read-guard").send("hello"));

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("raw-protocol");
    expect(
      JSON.stringify(await host.store.threads.load("read-guard"))
    ).toContain("raw-protocol");
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

  it("chains model.step.before transforms before append and event emission", async () => {
    const host = createInMemoryHost();
    const seen: string[] = [];
    const first = definePlugin((pss) => {
      pss.on("model.step.before", ({ messages }) => ({
        action: "transform",
        value: { messages: replaceAssistantText(messages, "intermediate") },
      }));
    });
    const second = definePlugin((pss) => {
      pss.on("model.step.before", ({ messages }) => {
        seen.push(JSON.stringify(messages));
        return {
          action: "transform",
          value: { messages: replaceAssistantText(messages, "sanitized") },
        };
      });
    });
    const agent = await createAgent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("raw-protocol")])
      ),
      plugins: [first, second],
    });

    const events = await collect(await agent.send("hello"));
    const eventJson = JSON.stringify(events);
    const storedJson = JSON.stringify(await host.store.threads.load("default"));

    expect(seen).toEqual([expect.stringContaining("intermediate")]);
    expect(eventJson).toContain("sanitized");
    expect(eventJson).not.toContain("raw-protocol");
    expect(eventJson).not.toContain("intermediate");
    expect(storedJson).toContain("sanitized");
    expect(storedJson).not.toContain("raw-protocol");
    expect(storedJson).not.toContain("intermediate");
  });

  it("fails model.step.before closed before append or output events", async () => {
    const host = createInMemoryHost();
    const plugin = definePlugin((pss) => {
      pss.on("model.step.before", ({ messages }) => {
        if (JSON.stringify(messages).includes("raw-protocol")) {
          throw new Error("model step rejected");
        }
        return { action: "continue" };
      });
    });
    const agent = await createAgent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("raw-protocol")])
      ),
      plugins: [plugin],
    });

    const events = await collect(await agent.send("hello"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn-error" })
    );
    expect(
      events.some(
        (event) =>
          event.type === "assistant-output" ||
          event.type === "assistant-reasoning" ||
          event.type === "tool-call" ||
          event.type === "tool-result"
      )
    ).toBe(false);
    expect(
      JSON.stringify(await host.store.threads.load("default"))
    ).not.toContain("raw-protocol");
    const usageIndex = events.findIndex(
      (event) => event.type === "model-usage"
    );
    const errorIndex = events.findIndex((event) => event.type === "turn-error");
    expect(usageIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeGreaterThan(usageIndex);
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

function replaceAssistantText(
  messages: readonly ModelStepOutput[number][],
  text: string
): ModelStepOutput {
  return messages.map((message) =>
    message.role === "assistant" ? { ...message, content: text } : message
  );
}
