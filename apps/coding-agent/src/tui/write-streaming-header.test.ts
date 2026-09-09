import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createToolRenderers } from "./renderers/tool-renderers";
import { sanitizeTerminalText } from "./terminal-safety";
import { BaseToolCallView } from "./tool-call-view";

const identity = (text: string): string => text;
const theme: MarkdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
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
const createView = (raw = false, toolName = "write_file") =>
  new BaseToolCallView(
    "stream",
    toolName,
    theme,
    undefined,
    raw,
    createToolRenderers()
  );
const header = (view: BaseToolCallView) => view.render(240)[0];
const finalHeader = (path: string) => {
  const view = createView();
  view.setFinalInput({ path, content: "" });
  view.setOutput("OK - wrote 0 bytes");
  const result = header(view);
  view.dispose();
  return result;
};

describe("streaming write header", () => {
  it("uses path-only and split paths before final input on the same card", async () => {
    const view = createView();
    try {
      await view.appendInputChunk('{"path":"');
      const generic = createView(false, "generic");
      generic.setPrettyBlock("**write_file** input", "");
      expect(header(view)).toBe(header(generic));
      generic.dispose();
      const card = view.children[0];
      for (const [chunk, path] of [
        ["ind", "ind"],
        ["ex.html", "index.html"],
        ['","content":"EARLY', "index.html"],
        ['\\nLATER"}', "index.html"],
      ]) {
        await view.appendInputChunk(chunk);
        expect(header(view)).toBe(finalHeader(path));
        expect(view.children).toEqual([card]);
      }
      expect(view.render(240).join("\n")).toContain("EARLY");
      expect(view.render(240).join("\n")).toContain("LATER");
      view.setFinalInput({ path: "index.html", content: "EARLY\nLATER" });
      expect(header(view)).toBe(finalHeader("index.html"));
      expect(view.children).toEqual([card]);
      view.setOutput("OK - wrote file");
      expect(header(view)).toBe(finalHeader("index.html"));
      expect(view.render(240).join("\n")).toContain("LATER");
      expect(view.children).toEqual([card]);
    } finally {
      view.dispose();
    }
  });

  it("keeps early content visible when content arrives before the path", async () => {
    const view = createView();
    try {
      await view.appendInputChunk('{"content":"EARLY');
      const before = header(view);
      const card = view.children[0];
      expect(view.render(240).join("\n")).toContain("EARLY");
      await view.appendInputChunk('","path":"');
      expect(header(view)).toBe(before);
      await view.appendInputChunk("late.html");
      expect(header(view)).toBe(finalHeader("late.html"));
      expect(view.render(240).join("\n")).toContain("EARLY");
      expect(view.children).toEqual([card]);
    } finally {
      view.dispose();
    }
  });

  it.each([
    "index.html",
    "目錄/한글.html",
    "`**not-bold**`[link](https://example.com).html",
    "```ticks``.html",
    " control\t\n\r\u001b]52;c;payload\u0007\u009b31m.html ",
  ])(
    "renders literal safe paths identically to the final header: %j",
    async (path) => {
      const view = createView();
      try {
        await view.appendInputChunk(JSON.stringify({ path }).slice(0, -1));
        expect(header(view)).toBe(finalHeader(path));
        expect(header(view)?.trimEnd()).toBe(
          ` write ${sanitizeTerminalText(path, path.length)}`.trimEnd()
        );
        expect(view.render(240)[1]).toBe("");
      } finally {
        view.dispose();
      }
    }
  );

  it.each(["", null, 123])(
    "keeps a generic header for invalid paths: %j",
    async (path) => {
      const view = createView();
      const expected = createView();
      try {
        expected.setPrettyBlock("**write_file** input", "");
        await view.appendInputChunk(JSON.stringify({ path, content: "EARLY" }));
        expect(header(view)).toBe(header(expected));
      } finally {
        view.dispose();
        expected.dispose();
      }
    }
  );

  it("preserves error headers and settled/aborted previews", async () => {
    const view = createView();
    const expected = createView();
    try {
      await view.appendInputChunk('{"path":"index.html","content":"EARLY');
      view.settle();
      expect(header(view)).toBe(finalHeader("index.html"));
      view.setError("WRITE_FAILED");
      expected.setFinalInput({ path: "index.html", content: "EARLY" });
      expected.setError("WRITE_FAILED");
      expect(view.render(240)).toEqual(expected.render(240));
      const frozen = view.render(240);
      view.dispose();
      await view.appendInputChunk("IGNORED");
      expect(view.render(240)).toEqual(frozen);
    } finally {
      view.dispose();
      expected.dispose();
    }
  });

  it("does not specialize raw mode or other tools", async () => {
    for (const [raw, tool] of [
      [true, "write_file"],
      [false, "unrelated_tool"],
    ] as const) {
      const view = createView(raw, tool);
      try {
        await view.appendInputChunk('{"content":"EARLY');
        const before = header(view);
        await view.appendInputChunk('","path":"index.html');
        expect(header(view)).toBe(before);
      } finally {
        view.dispose();
      }
    }
  });
});
