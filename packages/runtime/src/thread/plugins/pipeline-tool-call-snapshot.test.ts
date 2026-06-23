import { describe, expect, it } from "vitest";
import type { AgentEventContext, AgentToolCallContext } from "./pipeline";
import { runPluginsForToolCall } from "./pipeline";

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

describe("runPluginsForToolCall snapshots", () => {
  it("keeps plugin mutations out of the source context and later plugins", async () => {
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
      | Pick<AgentToolCallContext, "capabilities" | "input">
      | undefined;

    const result = await runPluginsForToolCall(
      [
        {
          onToolCall: (context) => {
            if (isMutableToolInput(context.input)) {
              context.input.path = "/tmp/mutated.txt";
              context.input.nested.value = "mutated";
            }

            const capability = context.capabilities[0];
            if (capability) {
              Object.assign(capability, { kind: "network", scope: "global" });
            }
          },
        },
        {
          onToolCall: (context) => {
            observedBySecond = {
              capabilities: context.capabilities,
              input: context.input,
            };
          },
        },
      ],
      {
        attempt: 1,
        capabilities,
        history: emptyHistory,
        idempotencyKey: "run-1:call_tool-1",
        input,
        policy: "manual-recovery",
        toolCallId: "call_tool-1",
        toolName: "write_file",
      }
    );

    expect(result).toEqual({ action: "continue" });
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
