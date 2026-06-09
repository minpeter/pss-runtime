import { describe, expect, it } from "vitest";
import { splitReplyBubbles } from "./replies";

describe("splitReplyBubbles", () => {
  it("returns a single bubble when the reply has no blank-line separator", () => {
    expect(splitReplyBubbles("Hello there.")).toEqual(["Hello there."]);
  });

  it("splits the reply into separate bubbles on double newlines", () => {
    expect(splitReplyBubbles("First paragraph.\n\nSecond paragraph.")).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);
  });

  it("trims whitespace and drops empty segments created by extra blank lines", () => {
    expect(splitReplyBubbles("  First.\n\n\n\n  Second.  ")).toEqual([
      "First.",
      "Second.",
    ]);
  });

  it("keeps single newlines inside one bubble", () => {
    expect(splitReplyBubbles("Line one\nLine two\n\nNext bubble.")).toEqual([
      "Line one\nLine two",
      "Next bubble.",
    ]);
  });
});