import { describe, expect, it } from "vitest";
import type { RuntimeInput } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";
import {
  attachInputMeta,
  attachRuntimeInputMeta,
  stripEventMeta,
  stripInputMeta,
} from "./input-meta";

describe("input-meta helpers", () => {
  it("attaches meta to user-input without mutating unrelated fields", () => {
    expect(
      attachInputMeta({ type: "user-input", text: "hello" }, { source: "send" })
    ).toEqual({
      type: "user-input",
      text: "hello",
      meta: { source: "send" },
    });
  });

  it("strips meta from user input before model mapping", () => {
    const input = attachInputMeta(
      { type: "user-input", text: "hello" },
      { source: "send" }
    );
    if (input.type !== "user-input") {
      throw new Error("expected user-input");
    }

    expect(userTextToModelMessage(input)).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("stripInputMeta is idempotent", () => {
    const withMeta = attachInputMeta(
      { type: "user-input", text: "hello" },
      { source: "delegate", delegateToolName: "poke" }
    );
    const stripped = stripInputMeta(withMeta);

    expect(stripInputMeta(stripped)).toEqual(stripped);
    expect(stripped).toEqual({ type: "user-input", text: "hello" });
  });

  it("stripEventMeta removes meta from runtime-input", () => {
    const event: RuntimeInput = attachRuntimeInputMeta(
      { type: "user-input", text: "steer me" },
      "step-end",
      { source: "steer", streaming: "steer" }
    );

    expect(stripEventMeta(event)).toEqual({
      type: "runtime-input",
      input: { type: "user-input", text: "steer me" },
      placement: "step-end",
    });
  });
});
