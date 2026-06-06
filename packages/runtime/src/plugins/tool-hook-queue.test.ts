import type { ToolExecutionOptions, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import type { AgentPluginScope } from "./scope";
import { runWithAgentPluginScope } from "./scope";
import { wrapToolsWithPluginHooks } from "./tool-hooks";
import type { AgentPluginToolCallEvent } from "./types";

const createToolExecutionOptions = (): ToolExecutionOptions<unknown> => ({
  abortSignal: new AbortController().signal,
  context: undefined,
  messages: [{ content: "tool prompt", role: "user" }],
  toolCallId: "tool-call-1",
});

const createTool = () =>
  tool({
    description: "Queued test tool.",
    execute: (input: unknown) => ({ allowed: input }),
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: true,
    }),
  });

describe("plugin tool hook queue", () => {
  it("serializes tool hook execution for one plugin scope", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const eventHandlers = new Map([
      [
        "tool.call",
        [
          async ({ input }: AgentPluginToolCallEvent) => {
            if (isRecord(input) && input.mode === "first") {
              order.push("first:start");
              await firstGate;
              order.push("first:end");
              return { action: "allow" };
            }
            order.push("second:start");
            return { action: "allow" };
          },
        ],
      ],
    ]) satisfies AgentPluginScope["eventHandlers"];
    const scope = createScope(eventHandlers);
    const tools = { guarded: createTool() } satisfies ToolSet;
    const wrapped = runWithAgentPluginScope(scope, () =>
      wrapToolsWithPluginHooks({
        history: [],
        signal: new AbortController().signal,
        tools,
      })
    );

    const guarded = wrapped?.guarded;
    if (!guarded || typeof guarded.execute !== "function") {
      throw new Error("expected guarded tool to be executable");
    }
    const first = guarded.execute(
      { mode: "first" },
      createToolExecutionOptions()
    );
    const second = guarded.execute(
      { mode: "second" },
      createToolExecutionOptions()
    );
    await Promise.resolve();

    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });
});

function createScope(
  eventHandlers: AgentPluginScope["eventHandlers"]
): AgentPluginScope {
  const signal = new AbortController().signal;
  return {
    eventHandlers,
    getCompactions: () => [],
    getPluginState: () => undefined,
    history: () => [],
    overlay: () => Promise.reject(new Error("unexpected overlay")),
    sessionKey: "tool-queue",
    setCompactions: () => undefined,
    setPluginState: () => undefined,
    signal,
    steer: () => Promise.reject(new Error("unexpected steer")),
    summarize: () => Promise.resolve(""),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
