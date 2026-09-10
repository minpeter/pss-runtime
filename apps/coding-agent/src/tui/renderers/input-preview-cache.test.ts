import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolInputPreviews } from "./input-preview";

const highlighting = await import("./highlight");
const originalHighlight = highlighting.highlightCode;

afterEach(() => vi.restoreAllMocks());

describe("streamed write preview highlighting", () => {
  it("bounds highlighted input to changed lines as a source grows", () => {
    const highlight = vi.spyOn(highlighting, "highlightCode");
    const preview = createToolInputPreviews().write_file;
    let content = "";
    for (let line = 0; line < 80; line += 1) {
      content += `export const item${line} = "value";\n`;
      expect(preview({ path: "generated.ts", content })?.body).toBe(
        originalHighlight(content)
      );
    }
    const processed = highlight.mock.calls.reduce(
      (total, [source]) => total + source.length,
      0
    );
    expect(processed).toBeLessThanOrEqual(content.length * 2);
  });

  it("recomputes edited, shortened and repaired source without stale rows", () => {
    const preview = createToolInputPreviews().write_file;
    for (const content of [
      'const a = "open',
      'const a = "closed";\nconst b = 1;',
      'const a = "changed";\r\nconst b = 1;',
      "const b = 1;",
      "\uD83D",
      "\uD83D\uDE80\n한글",
      "\x1b[31mtext\n",
      "",
      'const a = "restored";',
    ]) {
      expect(preview({ path: "generated.ts", content })?.body).toBe(
        originalHighlight(content)
      );
    }
    expect(preview({ path: "generated.ts" })?.body).toBe("");
    expect(preview({ path: "next.ts", content: "next" })?.body).toBe(
      originalHighlight("next")
    );
  });

  it("does not share retained highlights between separate tool views", () => {
    const input = { path: "generated.ts", content: "const value = 1;" };
    createToolInputPreviews().write_file(input);
    const highlight = vi.spyOn(highlighting, "highlightCode");
    const second = createToolInputPreviews().write_file(input);
    expect(second?.body).toBe(originalHighlight(input.content));
    expect(highlight).toHaveBeenCalled();
  });
});
