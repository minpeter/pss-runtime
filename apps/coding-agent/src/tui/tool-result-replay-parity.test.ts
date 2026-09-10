import { Readable } from "node:stream";
import type { ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import { agentEventStreamParts } from "./agent-event-stream";
import { sessionHistoryReplayParts } from "./session-history-replay";
import type { TuiStreamPart } from "./stream-handlers";

const cases: {
  name: string;
  output: ToolResultPart["output"];
  expected: TuiStreamPart;
}[] = [
  {
    name: "text error",
    output: { type: "error-text", value: "failed" },
    expected: { type: "tool-error", error: "failed" },
  },
  {
    name: "JSON error",
    output: { type: "error-json", value: { code: "INVALID_TOOL_ARGUMENTS" } },
    expected: { type: "tool-error", error: { code: "INVALID_TOOL_ARGUMENTS" } },
  },
  {
    name: "denial with reason",
    output: { type: "execution-denied", reason: "policy" },
    expected: { type: "tool-output-denied", reason: "policy" },
  },
  {
    name: "denial without reason",
    output: { type: "execution-denied" },
    expected: { type: "tool-output-denied" },
  },
  {
    name: "denial with empty reason",
    output: { type: "execution-denied", reason: "" },
    expected: { type: "tool-output-denied", reason: "" },
  },
  {
    name: "text success",
    output: { type: "text", value: "done" },
    expected: { type: "tool-result", output: "done" },
  },
  {
    name: "empty text success",
    output: { type: "text", value: "" },
    expected: { type: "tool-result", output: "" },
  },
  {
    name: "JSON success",
    output: { type: "json", value: { ok: true } },
    expected: { type: "tool-result", output: { ok: true } },
  },
  {
    name: "null JSON success",
    output: { type: "json", value: null },
    expected: { type: "tool-result", output: null },
  },
  ...(["error-text", "error-json", "execution-denied"] as const).map(
    (type) => ({
      name: `successful JSON containing ${type}`,
      output: { type: "json" as const, value: { type, value: "data" } },
      expected: { type: "tool-result", output: { type, value: "data" } },
    })
  ),
  {
    name: "content envelope",
    output: { type: "content", value: [{ type: "text", text: "content" }] },
    expected: {
      type: "tool-result",
      output: { type: "content", value: [{ type: "text", text: "content" }] },
    },
  },
];

describe.each(["assistant", "tool"] as const)(
  "%s tool result replay parity",
  (role) => {
    it.each(cases)("preserves $name", async ({ output, expected }) => {
      const result: ToolResultPart = {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "shell_execute",
        output,
      };
      const expectedPart = {
        ...expected,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
      };
      const events = Readable.from([result]);
      const live: TuiStreamPart[] = [];
      for await (const part of agentEventStreamParts(events)) {
        live.push(part);
      }

      expect(live).toStrictEqual([expectedPart]);
      expect(
        sessionHistoryReplayParts([{ role, content: [result] }])
      ).toStrictEqual([
        { type: "clear" },
        { type: "stream", part: expectedPart },
      ]);
    });
  }
);
