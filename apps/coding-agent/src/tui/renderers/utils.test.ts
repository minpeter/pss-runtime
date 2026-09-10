import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  formatGlobHeader,
  formatGrepHeader,
  normalizedLines,
  strippedLines,
} from "./utils";

const ESC = "\x1b";
const NEWLINE = /[\r\n]/;

it.each([formatGlobHeader, formatGrepHeader])(
  "keeps dynamic header segments in single-line code spans",
  (format) => {
    const pattern = "A`B\nC";
    const path = "D``E\rF";
    const include = "G```H\nI";
    const header = format(pattern, { path, include });
    expect(header).not.toMatch(NEWLINE);
    const spans: string[] = [];
    const identity = (text: string) => text;
    const theme: MarkdownTheme = {
      heading: identity,
      link: identity,
      linkUrl: identity,
      code: (text) => {
        spans.push(text);
        return text;
      },
      codeBlock: identity,
      codeBlockBorder: identity,
      quote: identity,
      quoteBorder: identity,
      hr: identity,
      listBullet: identity,
      bold: identity,
      italic: identity,
      strikethrough: identity,
      underline: identity,
    };
    new Markdown(header, 0, 0, theme).render(120);
    expect(spans).toEqual(
      format === formatGlobHeader
        ? ["A`B^JC", "D``E^MF"]
        : ["A`B^JC", "D``E^MF", "G```H^JI"]
    );
  }
);

describe("strippedLines", () => {
  it("removes SGR color sequences instead of escaping them", () => {
    const input = `${ESC}[32mPASS${ESC}[0m ${ESC}[31mFAIL${ESC}[0m`;

    expect(normalizedLines(input)).toEqual(["^[[32mPASS^[[0m ^[[31mFAIL^[[0m"]);
    expect(strippedLines(input)).toEqual(["PASS FAIL"]);
  });

  it("removes cursor movement and screen clears", () => {
    expect(strippedLines(`a${ESC}[2Jb${ESC}[10Ac`)).toEqual(["abc"]);
  });

  it("removes OSC hyperlink wrappers but keeps the label", () => {
    expect(
      strippedLines(`${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\`)
    ).toEqual(["link"]);
  });

  it("keeps remaining control characters visible", () => {
    expect(strippedLines("a\x00b")).toEqual(["a^@b"]);
  });

  it("splits on newlines after normalizing CRLF", () => {
    expect(strippedLines("a\r\nb")).toEqual(["a", "b"]);
  });
});
