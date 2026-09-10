import {
  type MarkdownTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createToolRenderers } from "./renderers/tool-renderers";
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

const GRAY_BG = "\x1b[100m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_DIM = "\x1b[2m";
const SYN_KEYWORD = "\x1b[38;2;86;156;214m";
const SYN_STRING = "\x1b[38;2;206;145;120m";

const createView = (toolName: string, raw = false) =>
  new BaseToolCallView(
    "preview",
    toolName,
    theme,
    undefined,
    raw,
    createToolRenderers()
  );

/** Feed one JSON argument payload in `chunks` slices, asserting no throw. */
const streamChunks = async (
  view: BaseToolCallView,
  payload: string,
  chunks: number
): Promise<void> => {
  const size = Math.ceil(payload.length / chunks);
  for (let start = 0; start < payload.length; start += size) {
    await view.appendInputChunk(payload.slice(start, start + size));
  }
};

const text = (view: BaseToolCallView): string => view.render(120).join("\n");
const plain = (view: BaseToolCallView): string =>
  view.render(120).map(stripTerminalSequences).join("\n");
const headerRow = (view: BaseToolCallView): string =>
  stripTerminalSequences(view.render(120)[0] ?? "").trim();

describe("tool input previews use the per-tool pretty grammar", () => {
  it.each(["__proto__", "constructor", "toString"])(
    "uses a generic preview for inherited name %s",
    async (name) => {
      const view = createView(name);
      try {
        await view.appendInputChunk('{"value":"CUSTOM_INPUT"}');
        expect(plain(view)).toContain("CUSTOM_INPUT");
      } finally {
        view.dispose();
      }
    }
  );
  it("write_file shows the write header with highlighted multi-line content, not a field dump", async () => {
    const view = createView("write_file");
    try {
      await streamChunks(
        view,
        '{"path":"src/generated.ts","content":"export const message = \\"hello\\";\\nexport const enabled = true;\\n"}'.slice(
          0,
          -1
        ),
        6
      );

      expect(headerRow(view)).toBe("write src/generated.ts");
      const body = plain(view);
      expect(body).toContain('export const message = "hello";');
      expect(body).toContain("export const enabled = true;");
      // no metadata dump once the body is available
      expect(body).not.toContain("path: src/generated.ts");
      expect(body).not.toContain("content:");
      // source body uses the shared code palette on the gray pretty background
      expect(text(view)).toContain(SYN_KEYWORD);
      expect(text(view)).toContain(SYN_STRING);
      expect(text(view)).toContain(GRAY_BG);
      // never claims a result
      expect(body).not.toContain("OK - wrote");
    } finally {
      view.dispose();
    }
  });

  it("write_file keeps the path header before any content field arrives", async () => {
    const view = createView("write_file");
    try {
      await view.appendInputChunk('{"path":"src/gen');
      expect(headerRow(view)).toBe("write src/gen");
      expect(plain(view)).not.toContain("content:");
      await view.appendInputChunk('erated.ts","content":"a');
      expect(headerRow(view)).toBe("write src/generated.ts");
      expect(plain(view)).toContain("a");
    } finally {
      view.dispose();
    }
  });

  it("read_file shows path/offset/limit and never invents file contents", async () => {
    const view = createView("read_file");
    try {
      await streamChunks(
        view,
        '{"path":"src/demo.ts","offset":1,"limit":3}'.slice(0, -1),
        4
      );

      expect(headerRow(view)).toBe("read src/demo.ts (offset: 1, limit: 3)");
      const body = plain(view).split("\n").slice(1).join("\n");
      expect(body.trim()).toBe("");
      expect(body).not.toContain("path:");
      expect(body).not.toContain("offset:");
    } finally {
      view.dispose();
    }
  });

  it("edit_file shows the edit header with proposed replacement lines and anchors, not a fabricated diff", async () => {
    const view = createView("edit_file");
    try {
      const payload = JSON.stringify({
        path: "src/demo.ts",
        expected_file_hash: "bd016ffe",
        edits: [
          {
            op: "replace",
            target: "2#HS",
            new_content: ["export const retries = 3;"],
          },
        ],
      });
      await streamChunks(view, payload.slice(0, -1), 7);

      expect(headerRow(view)).toBe("edit src/demo.ts");
      const body = plain(view);
      expect(body).toContain("export const retries = 3;");
      expect(body).toContain("replace 2#HS");
      expect(text(view)).toContain(ANSI_GREEN);
      // proposed only: no real diff markers, no original content, no hash dump
      expect(body).not.toContain("-2#HS");
      expect(body).not.toContain("export const retries = 2;");
      expect(body).not.toContain("expected_file_hash");
      expect(body).not.toContain("edits: 0:");
    } finally {
      view.dispose();
    }
  });

  it("edit_file tolerates an incomplete edits list mid-stream", async () => {
    const view = createView("edit_file");
    try {
      await view.appendInputChunk('{"path":"src/demo.ts","edits":[{"op":"rep');
      expect(headerRow(view)).toBe("edit src/demo.ts");
      await view.appendInputChunk('lace","target":"2#H');
      expect(headerRow(view)).toBe("edit src/demo.ts");
      await view.appendInputChunk(
        'S","new_content":["export const retries = 3;'
      );
      expect(plain(view)).toContain("export const retries = 3;");
    } finally {
      view.dispose();
    }
  });

  it("shell_execute shows the bash command preview with no fake stdout or exit code", async () => {
    const view = createView("shell_execute");
    try {
      await streamChunks(
        view,
        JSON.stringify({
          command: "printf 'ready: local fixture\\nitems: 2\\n'",
        }).slice(0, -1),
        5
      );

      expect(headerRow(view)).toBe(
        "bash printf 'ready: local fixture\\nitems: 2\\n'"
      );
      const body = plain(view).split("\n").slice(1).join("\n");
      expect(body.trim()).toBe("");
      expect(body).not.toContain("command:");
      expect(body).not.toContain("exit");
      expect(body).not.toContain("(No output)");
    } finally {
      view.dispose();
    }
  });

  it("glob_files shows the pattern and path with no fake matches", async () => {
    const view = createView("glob_files");
    try {
      await streamChunks(
        view,
        JSON.stringify({ pattern: "**/*", path: "src", max_results: 10 }).slice(
          0,
          -1
        ),
        4
      );

      expect(headerRow(view)).toBe("glob **/* (path: src)");
      const body = plain(view).split("\n").slice(1).join("\n");
      // no invented matches; only fields the model actually streamed
      expect(body).not.toContain("src/demo.ts");
      expect(body).not.toContain("OK -");
      expect(body).not.toContain("pattern:");
      // fields the header cannot show survive as a dim footnote
      expect(body).toContain("max_results: 10");
      expect(text(view)).toContain(ANSI_DIM);
      // A metadata footnote is not a content body: no gray block behind it.
      expect(text(view)).not.toContain(GRAY_BG);
    } finally {
      view.dispose();
    }
  });

  it("grep_files shows the pattern, path and include conditions with no fake matches", async () => {
    const view = createView("grep_files");
    try {
      await streamChunks(
        view,
        JSON.stringify({
          pattern: "TODO",
          path: "src",
          include: "*",
          max_results: 10,
        }).slice(0, -1),
        6
      );

      expect(headerRow(view)).toBe("grep TODO (path: src, include: *)");
      const body = plain(view).split("\n").slice(1).join("\n");
      expect(body).not.toContain("src/demo.ts:");
      expect(body).not.toContain("OK -");
      expect(body).not.toContain("pattern:");
      expect(body).toContain("max_results: 10");
    } finally {
      view.dispose();
    }
  });

  it("renders narrow CJK write paths and content without throwing", async () => {
    const view = createView("write_file");
    try {
      await streamChunks(
        view,
        JSON.stringify({
          path: "目錄/한글.ts",
          content: "const 라벨 = '목록';\n",
        }).slice(0, -1),
        9
      );

      expect(headerRow(view)).toBe("write 目錄/한글.ts");
      expect(plain(view)).toContain("목록");
      expect(view.render(24).length).toBeGreaterThan(0);
    } finally {
      view.dispose();
    }
  });

  it("keeps the generic field preview for unknown tools", async () => {
    const view = createView("mystery_tool");
    try {
      await view.appendInputChunk('{"alpha":"one","beta":2');
      expect(headerRow(view)).toBe("mystery_tool input");
      expect(plain(view)).toContain("alpha: one");
      expect(plain(view)).toContain("beta: 2");
    } finally {
      view.dispose();
    }
  });

  it("raw mode bypasses pretty previews for every specialized tool", async () => {
    for (const tool of [
      "write_file",
      "read_file",
      "edit_file",
      "shell_execute",
      "glob_files",
      "grep_files",
    ]) {
      const view = createView(tool, true);
      try {
        await view.appendInputChunk('{"path":"p","command":"c","pattern":"g"');
        expect(plain(view)).toContain("Tool");
        expect(plain(view)).toContain(tool);
      } finally {
        view.dispose();
      }
    }
  });

  it("hands the card back to the result renderer once real output lands", async () => {
    const view = createView("shell_execute");
    try {
      await view.appendInputChunk('{"command":"echo hi"');
      expect(plain(view)).not.toContain("REAL_STDOUT");
      await view.appendInputChunk("}");
      view.setFinalInput({ command: "echo hi" });
      expect(plain(view)).not.toContain("REAL_STDOUT");
      view.setOutput(
        "OK - command finished\nexit_code: 0\nsignal: none\nstdout:\nREAL_STDOUT\nstderr:\n"
      );
      expect(plain(view)).toContain("REAL_STDOUT");
    } finally {
      view.dispose();
    }
  });

  it("still surfaces INVALID_TOOL_ARGUMENTS instead of a pretty preview", async () => {
    const view = createView("write_file");
    try {
      await view.appendInputChunk('{"path":"src/x.ts","content":"partial');
      view.setError({
        code: "INVALID_TOOL_ARGUMENTS",
        kind: "parse",
        message: "unterminated string",
      });
      const body = plain(view);
      expect(body).toContain("invalid arguments (not executed)");
      expect(body).toContain("unterminated string");
    } finally {
      view.dispose();
    }
  });
});
