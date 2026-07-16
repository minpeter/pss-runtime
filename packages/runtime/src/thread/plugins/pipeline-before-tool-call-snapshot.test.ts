import { describe, expect, it } from "vitest";
import type { PluginToolCallBeforeEvent } from "../../plugins/api";
import type { AgentEventContext } from "./pipeline";
import { runPluginsForEvent } from "./pipeline";

const emptyHistory: AgentEventContext["history"] = [];

interface MutableToolInput {
  readonly nested: {
    value: string;
  };
  path: string;
}

function isMutableToolInput(value: unknown): value is MutableToolInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "nested" in value &&
    "path" in value &&
    typeof value.path === "string" &&
    typeof value.nested === "object" &&
    value.nested !== null &&
    "value" in value.nested &&
    typeof value.nested.value === "string"
  );
}

function beforeToolCallEvent(input: unknown): PluginToolCallBeforeEvent {
  return {
    attempt: 1,
    idempotencyKey: "run-1:call_tool-1",
    input,
    policy: "manual-recovery",
    toolCallId: "call_tool-1",
    toolName: "write_file",
    type: "tool.call.before",
  };
}

describe("tool.call.before plugin snapshots", () => {
  it("keeps plugin input mutations out of the source event and later plugins", async () => {
    const input = {
      nested: { value: "original" },
      path: "/tmp/example.txt",
    };
    let observedBySecond: Pick<PluginToolCallBeforeEvent, "input"> | undefined;

    const result = await runPluginsForEvent(
      [
        {
          on: ({ event }) => {
            if (event.type !== "tool.call.before") {
              return;
            }

            if (isMutableToolInput(event.input)) {
              event.input.path = "/tmp/mutated.txt";
              event.input.nested.value = "mutated";
            }
          },
        },
        {
          on: ({ event }) => {
            if (event.type !== "tool.call.before") {
              return;
            }

            observedBySecond = {
              input: event.input,
            };
          },
        },
      ],
      {
        event: beforeToolCallEvent(input),
        history: emptyHistory,
      }
    );

    expect(result).toEqual({
      kind: "emit",
      event: beforeToolCallEvent(input),
    });
    expect(input).toEqual({
      nested: { value: "original" },
      path: "/tmp/example.txt",
    });
    expect(observedBySecond).toEqual({
      input: {
        nested: { value: "original" },
        path: "/tmp/example.txt",
      },
    });
  });
});
