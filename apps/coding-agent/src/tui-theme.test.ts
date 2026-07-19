import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  assistantText,
  boldText,
  darkGrayText,
  dimText,
  errorText,
  markdownDefaultTextStyle,
  markdownTheme,
  reasoningText,
  toolText,
  userText,
} from "./tui-theme";

describe("TUI theme", () => {
  it("wraps label colors in a single SGR code and a full reset", () => {
    expect(userText("you")).toBe("\x1b[36myou\x1b[0m");
    expect(assistantText("assistant")).toBe("\x1b[32massistant\x1b[0m");
    expect(toolText("tool")).toBe("\x1b[33mtool\x1b[0m");
    expect(errorText("error")).toBe("\x1b[31merror\x1b[0m");
    expect(reasoningText("reasoning")).toBe("\x1b[35mreasoning\x1b[0m");
    expect(dimText("done")).toBe("\x1b[2mdone\x1b[0m");
    expect(boldText("pss-next")).toBe("\x1b[1mpss-next\x1b[0m");
    expect(darkGrayText("#abc")).toBe("\x1b[90m#abc\x1b[0m");
  });

  it("provides a style function for every markdown element", () => {
    const requiredKeys: readonly (keyof MarkdownTheme)[] = [
      "bold",
      "code",
      "codeBlock",
      "codeBlockBorder",
      "heading",
      "hr",
      "italic",
      "link",
      "linkUrl",
      "listBullet",
      "quote",
      "quoteBorder",
      "strikethrough",
      "underline",
    ];

    for (const key of requiredKeys) {
      expect(markdownTheme[key]).toBeTypeOf("function");
    }
  });

  it("styles markdown body text with the assistant color", () => {
    expect(markdownDefaultTextStyle.color?.("body")).toBe(
      "\x1b[32mbody\x1b[0m"
    );
  });

  it("renders markdown chrome without crashing", () => {
    expect(markdownTheme.heading("Title")).toContain("Title");
    expect(markdownTheme.codeBlockBorder("|")).toBe("\x1b[2m|\x1b[0m");
  });
});
