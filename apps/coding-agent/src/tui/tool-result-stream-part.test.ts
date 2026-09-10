import { describe, expect, it } from "vitest";
import { toolResultStreamPart } from "./tool-result-stream-part";

const identity = { toolCallId: "call-1", toolName: "shell_execute" };

describe("toolResultStreamPart", () => {
  it.each([
    undefined,
    null,
    false,
    0,
    "raw output",
    ["raw", "array"],
    { value: "untyped" },
    { type: "unknown", value: "data" },
    { type: "text" },
    { type: "json" },
    { type: "content", value: [{ type: "text", text: "data" }] },
  ])("preserves raw or unrecognized output %#", (output) => {
    const part = toolResultStreamPart({ ...identity, output });
    expect(part).toStrictEqual({ ...identity, type: "tool-result", output });
    expect(part.output).toBe(output);
  });

  it.each([false, 0, "", null])("unwraps falsy JSON value %j", (value) => {
    expect(
      toolResultStreamPart({ ...identity, output: { type: "json", value } })
    ).toStrictEqual({ ...identity, type: "tool-result", output: value });
  });

  it("does not add an undefined denial reason", () => {
    expect(
      toolResultStreamPart({
        ...identity,
        output: { type: "execution-denied", reason: undefined },
      })
    ).toStrictEqual({ ...identity, type: "tool-output-denied" });
  });
});
