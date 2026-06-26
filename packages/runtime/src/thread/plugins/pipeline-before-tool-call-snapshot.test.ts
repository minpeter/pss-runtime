import { describe, expect, it } from "vitest";
import type { BeforeToolCall } from "../protocol/events";
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

function beforeToolCallEvent(
  input: unknown,
  capabilities: BeforeToolCall["capabilities"]
): BeforeToolCall {
  return {
    attempt: 1,
    capabilities,
    idempotencyKey: "run-1:call_tool-1",
    input,
    policy: "manual-recovery",
    toolCallId: "call_tool-1",
    toolName: "write_file",
    type: "before-tool-call",
  };
}

describe("before-tool-call plugin snapshots", () => {
  it("keeps plugin mutations out of the source event and later plugins", async () => {
    const input = {
      nested: { value: "original" },
      path: "/tmp/example.txt",
    };
    const capabilities = [
      {
        kind: "filesystem",
        scope: "workspace",
      },
    ];
    let observedBySecond:
      | Pick<BeforeToolCall, "capabilities" | "input">
      | undefined;

    const result = await runPluginsForEvent(
      [
        {
          on: ({ event }) => {
            if (event.type !== "before-tool-call") {
              return;
            }

            if (isMutableToolInput(event.input)) {
              event.input.path = "/tmp/mutated.txt";
              event.input.nested.value = "mutated";
            }

            const capability = event.capabilities[0];
            if (capability) {
              Object.assign(capability, { kind: "network", scope: "global" });
            }
          },
        },
        {
          on: ({ event }) => {
            if (event.type !== "before-tool-call") {
              return;
            }

            observedBySecond = {
              capabilities: event.capabilities,
              input: event.input,
            };
          },
        },
      ],
      {
        event: beforeToolCallEvent(input, capabilities),
        history: emptyHistory,
      }
    );

    expect(result).toEqual({
      kind: "emit",
      event: beforeToolCallEvent(input, capabilities),
    });
    expect(input).toEqual({
      nested: { value: "original" },
      path: "/tmp/example.txt",
    });
    expect(capabilities).toEqual([
      {
        kind: "filesystem",
        scope: "workspace",
      },
    ]);
    expect(observedBySecond).toEqual({
      capabilities: [
        {
          kind: "filesystem",
          scope: "workspace",
        },
      ],
      input: {
        nested: { value: "original" },
        path: "/tmp/example.txt",
      },
    });
  });
});
