import { describe, expect, it } from "vitest";
import type { RuntimeInput } from "./events";
import {
  attachInputMeta,
  attachRuntimeInputMeta,
  stripEventMeta,
  stripInputMeta,
} from "./input-meta";
import { userTextToModelMessage } from "./mapping";

describe("input-meta helpers", () => {
  it("attaches meta to user-text without mutating unrelated fields", () => {
    expect(
      attachInputMeta({ type: "user-text", text: "hello" }, { source: "send" })
    ).toEqual({
      type: "user-text",
      text: "hello",
      meta: { source: "send" },
    });
  });

  it("strips meta from user input before model mapping", () => {
    const input = attachInputMeta(
      { type: "user-text", text: "hello" },
      { source: "send" }
    );
    if (input.type !== "user-text") {
      throw new Error("expected user-text");
    }

    expect(userTextToModelMessage(input)).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("stripInputMeta is idempotent", () => {
    const withMeta = attachInputMeta(
      { type: "user-text", text: "hello" },
      { source: "delegate", delegateToolName: "poke" }
    );
    const stripped = stripInputMeta(withMeta);

    expect(stripInputMeta(stripped)).toEqual(stripped);
    expect(stripped).toEqual({ type: "user-text", text: "hello" });
  });

  it("stripEventMeta removes meta from runtime-input", () => {
    const event: RuntimeInput = attachRuntimeInputMeta(
      { type: "user-text", text: "steer me" },
      "step-end",
      { source: "steer", streaming: "steer" }
    );

    expect(stripEventMeta(event)).toEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "steer me" },
      placement: "step-end",
    });
  });
});