import { describe, expect, it } from "vitest";
import { splitReplyBubbles } from "./replies";
import { parseReplySegments, telegramReplyBubbles } from "./reply-segments";

describe("splitReplyBubbles baseline", () => {
  it("splits plain text on double newlines", () => {
    expect(splitReplyBubbles("a\n\nb")).toEqual(["a", "b"]);
  });
});

describe("parseReplySegments", () => {
  it("returns a single plain segment when no block tags are present", () => {
    expect(parseReplySegments("Hello there.")).toEqual([
      { kind: "plain", content: "Hello there." },
    ]);
  });

  it("parses a single block segment", () => {
    expect(parseReplySegments("<block>line1\nline2\n\nline3</block>")).toEqual([
      { kind: "block", content: "line1\nline2\n\nline3" },
    ]);
  });

  it("parses interleaved plain and block segments", () => {
    expect(
      parseReplySegments("Hi\n\n<block>List:\n- one</block>\n\nBye")
    ).toEqual([
      { kind: "plain", content: "Hi\n\n" },
      { kind: "block", content: "List:\n- one" },
      { kind: "plain", content: "\n\nBye" },
    ]);
  });

  it("treats an unclosed block tag as plain text", () => {
    expect(parseReplySegments("Before <block>never closed")).toEqual([
      { kind: "plain", content: "Before " },
      { kind: "plain", content: "<block>never closed" },
    ]);
  });

  it("does not treat nested block tags as nested blocks", () => {
    expect(
      parseReplySegments("<block>outer <block>inner</block> tail</block>")
    ).toEqual([
      { kind: "block", content: "outer <block>inner" },
      { kind: "plain", content: " tail</block>" },
    ]);
  });
});

describe("telegramReplyBubbles", () => {
  it("delegates plain text to splitReplyBubbles", () => {
    expect(telegramReplyBubbles("a\n\nb")).toEqual(["a", "b"]);
  });

  it("keeps block content in a single bubble", () => {
    expect(
      telegramReplyBubbles("<block>line1\nline2\n\nline3</block>")
    ).toEqual(["line1\nline2\n\nline3"]);
  });

  it("splits plain segments and preserves block segments", () => {
    expect(
      telegramReplyBubbles("Hi\n\n<block>List:\n- one</block>\n\nBye")
    ).toEqual(["Hi", "List:\n- one", "Bye"]);
  });

  it("delivers unclosed block tags as plain bubbles", () => {
    expect(telegramReplyBubbles("Before <block>never closed")).toEqual([
      "Before",
      "<block>never closed",
    ]);
  });
});
