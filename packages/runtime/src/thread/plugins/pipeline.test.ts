import { describe, expect, it } from "vitest";
import type { PluginToolCallBeforeEvent } from "../../plugins/api";
import type { AgentEventContext } from "./pipeline";
import { type AgentPlugin, runPluginsForEvent } from "./pipeline";

const emptyHistory: AgentEventContext["history"] = [];

describe("runPluginsForEvent", () => {
  it("chains transforms on user-input in plugin registration order", async () => {
    const prefixA: AgentPlugin = {
      on: ({ event }) => {
        if (
          event.type !== "user-input" ||
          !("text" in event) ||
          typeof event.text !== "string"
        ) {
          return;
        }
        return {
          action: "transform",
          event: { ...event, text: `A:${event.text}` },
        };
      },
    };
    const prefixB: AgentPlugin = {
      on: ({ event }) => {
        if (
          event.type !== "user-input" ||
          !("text" in event) ||
          typeof event.text !== "string"
        ) {
          return;
        }
        return {
          action: "transform",
          event: { ...event, text: `B:${event.text}` },
        };
      },
    };

    const result = await runPluginsForEvent([prefixA, prefixB], {
      event: { type: "user-input", text: "hello" },
      history: emptyHistory,
    });

    expect(result).toEqual({
      kind: "emit",
      event: { type: "user-input", text: "B:A:hello" },
    });
  });

  it("returns handled when a plugin handles an interceptable event", async () => {
    const handledPlugin: AgentPlugin = {
      on: () => ({ action: "handled" }),
    };

    const result = await runPluginsForEvent([handledPlugin], {
      event: { type: "user-input", text: "hello" },
      history: emptyHistory,
    });

    expect(result).toEqual({ kind: "handled" });
  });

  it("ignores transform returns on non-interceptable events", async () => {
    const transformTurnStart: AgentPlugin = {
      on: () => ({
        action: "transform",
        event: { type: "user-input", text: "should-not-apply" },
      }),
    };

    const result = await runPluginsForEvent([transformTurnStart], {
      event: { type: "turn-start" },
      history: emptyHistory,
    });

    expect(result).toEqual({ kind: "emit", event: { type: "turn-start" } });
  });

  it("gives each observe-only plugin an isolated event snapshot", async () => {
    const usage = {
      attemptId: "attempt-1",
      cacheReadTokens: 80,
      inputTokens: 100,
      type: "model-usage",
    } as const;
    const observed: unknown[] = [];

    await runPluginsForEvent(
      [
        {
          on: ({ event }) => {
            (event as { cacheReadTokens?: number }).cacheReadTokens = 999;
          },
        },
        {
          on: ({ event }) => {
            observed.push(event);
          },
        },
      ],
      { event: usage, history: emptyHistory },
      { observeOnly: true }
    );

    expect(usage.cacheReadTokens).toBe(80);
    expect(observed).toEqual([usage]);
  });

  it("ignores invalid JavaScript plugin returns", async () => {
    const invalidReturns: unknown[] = [null, false, 0, "continue"];

    for (const value of invalidReturns) {
      await expect(
        runPluginsForEvent(
          [{ on: () => value as ReturnType<NonNullable<AgentPlugin["on"]>> }],
          {
            event: { type: "user-input", text: "hello" },
            history: emptyHistory,
          }
        )
      ).resolves.toEqual({
        event: { type: "user-input", text: "hello" },
        kind: "emit",
      });
    }
  });
});

describe("tool.call.before interception", () => {
  const beforeToolCall = {
    attempt: 1,
    idempotencyKey: "run-1:call_tool-1",
    input: { path: "/tmp/example.txt" },
    policy: "manual-recovery",
    toolCallId: "call_tool-1",
    toolName: "write_file",
    type: "tool.call.before",
  } satisfies PluginToolCallBeforeEvent;

  it("stops at the first plugin that requests recovery", async () => {
    const calls: string[] = [];
    const result = await runPluginsForEvent(
      [
        {
          on: () => {
            calls.push("first");
            return { action: "continue" };
          },
        },
        {
          on: () => {
            calls.push("second");
            return { action: "needs-recovery" };
          },
        },
        {
          on: () => {
            calls.push("third");
            return { action: "continue" };
          },
        },
      ],
      {
        event: beforeToolCall,
        history: emptyHistory,
      }
    );

    expect(result).toEqual({ kind: "needs-recovery" });
    expect(calls).toEqual(["first", "second"]);
  });

  it("continues after handled returns on tool.call.before", async () => {
    const calls: string[] = [];
    const result = await runPluginsForEvent(
      [
        {
          on: () => {
            calls.push("handled");
            return { action: "handled" };
          },
        },
        {
          on: () => {
            calls.push("recovery");
            return { action: "needs-recovery" };
          },
        },
      ],
      {
        event: beforeToolCall,
        history: emptyHistory,
      }
    );

    expect(result).toEqual({ kind: "needs-recovery" });
    expect(calls).toEqual(["handled", "recovery"]);
  });

  it("ignores invalid JavaScript returns and continues in registration order", async () => {
    const calls: string[] = [];
    const invalidReturns: unknown[] = [null, false, 0, "needs-recovery", {}];
    const plugins: AgentPlugin[] = invalidReturns.map((value, index) => ({
      on: () => {
        calls.push(`invalid-${index}`);
        return value as ReturnType<NonNullable<AgentPlugin["on"]>>;
      },
    }));
    plugins.push({
      on: () => {
        calls.push("continue");
        return { action: "continue" };
      },
    });

    const result = await runPluginsForEvent(plugins, {
      event: beforeToolCall,
      history: emptyHistory,
    });

    expect(result).toEqual({ kind: "emit", event: beforeToolCall });
    expect(calls).toEqual([
      "invalid-0",
      "invalid-1",
      "invalid-2",
      "invalid-3",
      "invalid-4",
      "continue",
    ]);
  });

  it("ignores transform returns on tool.call.before", async () => {
    const result = await runPluginsForEvent(
      [
        {
          on: () => ({
            action: "transform",
            event: { type: "user-input", text: "should-not-apply" },
          }),
        },
      ],
      {
        event: beforeToolCall,
        history: emptyHistory,
      }
    );

    expect(result).toEqual({ kind: "emit", event: beforeToolCall });
  });
});
