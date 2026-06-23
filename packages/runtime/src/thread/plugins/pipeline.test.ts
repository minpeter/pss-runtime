import { describe, expect, it } from "vitest";
import type { AgentEventContext, AgentToolCallContext } from "./pipeline";
import {
  type AgentPlugin,
  runPluginsForEvent,
  runPluginsForToolCall,
} from "./pipeline";

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

describe("runPluginsForToolCall", () => {
  const toolContext = {
    attempt: 1,
    capabilities: [],
    history: emptyHistory,
    idempotencyKey: "run-1:call_tool-1",
    input: { path: "/tmp/example.txt" },
    policy: "manual-recovery",
    toolCallId: "call_tool-1",
    toolName: "write_file",
  } satisfies AgentToolCallContext;

  it("stops at the first plugin that requests recovery", async () => {
    const calls: string[] = [];
    const result = await runPluginsForToolCall(
      [
        {
          onToolCall: () => {
            calls.push("first");
            return { action: "continue" };
          },
        },
        {
          onToolCall: () => {
            calls.push("second");
            return { action: "needs-recovery" };
          },
        },
        {
          onToolCall: () => {
            calls.push("third");
            return { action: "continue" };
          },
        },
      ],
      toolContext
    );

    expect(result).toEqual({ action: "needs-recovery" });
    expect(calls).toEqual(["first", "second"]);
  });

  it("ignores invalid JavaScript returns and continues in registration order", async () => {
    const calls: string[] = [];
    const invalidReturns: unknown[] = [null, false, 0, "needs-recovery", {}];
    const plugins: AgentPlugin[] = invalidReturns.map((value, index) => ({
      onToolCall: () => {
        calls.push(`invalid-${index}`);
        return value as ReturnType<NonNullable<AgentPlugin["onToolCall"]>>;
      },
    }));
    plugins.push({
      onToolCall: () => {
        calls.push("continue");
        return { action: "continue" };
      },
    });

    const result = await runPluginsForToolCall(plugins, toolContext);

    expect(result).toEqual({ action: "continue" });
    expect(calls).toEqual([
      "invalid-0",
      "invalid-1",
      "invalid-2",
      "invalid-3",
      "invalid-4",
      "continue",
    ]);
  });
});
