import { describe, expect, it } from "vitest";
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
