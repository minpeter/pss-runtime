import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type MarkdownTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { computeFileHash } from "../workspace-tools/hashline";
import { createReadFileTool } from "../workspace-tools/read-file";
import { agentEventStreamParts } from "./agent-event-stream";
import { captureComponent, renderColdContent } from "./cold-content";
import { createToolRenderers } from "./renderers/tool-renderers";
import type { TuiStreamPart } from "./stream-handlers";
import { BaseToolCallView } from "./tool-call-view";

const HASHLINE_ANCHOR_PATTERN = /\d+#[A-Z]+\|/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: assert an ANSI background without pinning its palette color
const BACKGROUND_PATTERN = /\x1b\[(?:4[0-8]|10[0-7])(?:;[\d;]+)?m/;
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
const createView = (raw = false) =>
  new BaseToolCallView(
    "read-stream",
    "read_file",
    theme,
    undefined,
    raw,
    createToolRenderers()
  );
const text = (view: BaseToolCallView) =>
  view.render(160).map(stripTerminalSequences).join("\n");

// Equality asserts a shared shipped header, not a separate wording contract.
describe("streamed read display", () => {
  it("uses the completed header for streamed paths and ranges without claiming file content", async () => {
    const streamed = createView();
    const completed = createView();
    try {
      for (const [chunk, input] of [
        ['{"path":"READ', { path: "READ" }],
        ['ME.md","offset":1', { path: "README.md", offset: 1 }],
        [',"limit":65}', { path: "README.md", offset: 1, limit: 65 }],
      ] as const) {
        await streamed.appendInputChunk(chunk);
        completed.setFinalInput(input);
        completed.setOutput(
          "OK - file\npath: README.md\nfile_hash: unused\nlines: 0/0\n"
        );
        expect(streamed.render(160)[0]).toEqual(completed.render(160)[0]);
        expect(text(streamed)).not.toContain("READ_SENTINEL");
      }
      streamed.setFinalInput({ path: "README.md", offset: 1, limit: 65 });
      expect(streamed.render(160)[0]).toEqual(completed.render(160)[0]);
    } finally {
      streamed.dispose();
      completed.dispose();
    }
  });

  it.each(["README.md", "目錄/한글.md", "`**literal**`.md"])(
    "uses the safe completed path header while pending: %j",
    async (path) => {
      const pending = createView();
      const completed = createView();
      try {
        await pending.appendInputChunk(JSON.stringify({ path }).slice(0, -1));
        completed.setFinalInput({ path });
        expect(pending.render(160)[0]).toEqual(completed.render(160)[0]);
        expect(stripTerminalSequences(pending.render(160)[0] ?? "")).toContain(
          path
        );
      } finally {
        pending.dispose();
        completed.dispose();
      }
    }
  );

  it("preserves raw headers and generic fallback until a path is present", async () => {
    const raw = createView(true);
    const fallback = createView();
    try {
      await raw.appendInputChunk('{"offset":1');
      const rawHeader = raw.render(160)[0];
      await raw.appendInputChunk(',"path":"README.md"}');
      expect(raw.render(160)[0]).toBe(rawHeader);
      await fallback.appendInputChunk('{"offset":1');
      const noPathHeader = fallback.render(160)[0];
      await fallback.appendInputChunk(',"path":""}');
      expect(fallback.render(160)[0]).toBe(noPathHeader);
    } finally {
      raw.dispose();
      fallback.dispose();
    }
  });

  it("renders a real read result, preserving canonical hashes, range, content and file permissions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pss-read-display-"));
    const view = createView();
    try {
      const content = `${Array.from({ length: 70 }, (_, i) => `READ_SENTINEL_${i + 1}`).join("\n")}\n`;
      const path = join(workspace, "README.md");
      await writeFile(path, content, { mode: 0o640 });
      const before = await stat(path);
      await view.appendInputChunk('{"path":"README.md","offset":1,"limit":65}');
      const input = { path: "README.md", offset: 1, limit: 65 };
      view.setFinalInput(input);
      expect(text(view)).not.toContain("READ_SENTINEL");
      const tool = createReadFileTool(workspace);
      const output = await tool.execute?.(input, {
        toolCallId: "read-stream",
        messages: [],
        context: undefined,
      });
      expect(typeof output).toBe("string");
      expect(output).toContain(`file_hash: ${computeFileHash(content)}`);
      expect(output).toContain("lines: 1-65/70");
      expect(output).toContain("READ_SENTINEL_1\n");
      expect(output).toContain("READ_SENTINEL_65");
      expect(output).not.toContain("READ_SENTINEL_66");
      expect(text(view)).not.toContain("READ_SENTINEL");
      view.setOutput(output);
      expect(text(view)).toContain("READ_SENTINEL_65");
      expect(text(view)).not.toContain("READ_SENTINEL_1\n");
      expect(text(view)).not.toContain("file_hash");
      expect(text(view)).not.toMatch(HASHLINE_ANCHOR_PATTERN);
      const cold = captureComponent(view, 160);
      expect(renderColdContent(cold, 160)).toEqual(view.render(160));
      expect(
        renderColdContent(cold, 48).map(stripTerminalSequences).join("\n")
      ).toContain("READ_SENTINEL_65");
      expect(await readFile(path, "utf8")).toBe(content);
      const after = await stat(path);
      expect(after.mode).toBe(before.mode);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      view.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("shows real directory results and empty files without inventing contents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pss-read-display-"));
    const view = createView();
    try {
      await mkdir(join(workspace, "listing"));
      await mkdir(join(workspace, "listing", "child"));
      await writeFile(join(workspace, "listing", "empty.txt"), "");
      const tool = createReadFileTool(workspace);
      const input = { path: "listing" };
      view.setFinalInput(input);
      view.setOutput(
        await tool.execute?.(input, {
          toolCallId: "read-stream",
          messages: [],
          context: undefined,
        })
      );
      expect(text(view)).toContain("child/");
      expect(text(view)).toContain("empty.txt");
      const directoryRows = view.render(160);
      expect(directoryRows).toEqual(directoryRows.map(stripTerminalSequences));
      const empty = { path: "listing/empty.txt" };
      view.setFinalInput(empty);
      const output = await tool.execute?.(empty, {
        toolCallId: "read-stream",
        messages: [],
        context: undefined,
      });
      expect(output).toContain("lines: 0/0");
      view.setOutput(output);
      expect(view.render(160)).toHaveLength(1);
    } finally {
      view.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("unwraps a same-id text result and routes execution errors to the error surface", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pss-read-display-"));
    const view = createView();
    try {
      const input = { path: "missing.txt" };
      const tool = createReadFileTool(workspace);
      let failure: unknown;
      try {
        await tool.execute?.(input, {
          toolCallId: "read-stream",
          messages: [],
          context: undefined,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      function* events() {
        yield {
          type: "tool-result" as const,
          toolCallId: "read-stream",
          toolName: "read_file",
          output: { type: "text" as const, value: "READ_SENTINEL" },
        };
        yield {
          type: "tool-result" as const,
          toolCallId: "read-stream",
          toolName: "read_file",
          output: { type: "error-text" as const, value: String(failure) },
        };
      }
      const parts: TuiStreamPart[] = [];
      for await (const part of agentEventStreamParts(Readable.from(events()))) {
        parts.push(part);
      }
      expect(parts[0]).toMatchObject({
        type: "tool-result",
        toolCallId: "read-stream",
        output: "READ_SENTINEL",
      });
      expect(parts[1]).toMatchObject({
        type: "tool-error",
        toolCallId: "read-stream",
        error: String(failure),
      });
      view.setFinalInput(input);
      view.setError(parts[1]?.error);
      expect(text(view)).toContain("ENOENT");
      const errorSurface = createView();
      try {
        errorSurface.setPrettyBlock("", String(failure), { isError: true });
        expect(view.render(160).slice(2)).toEqual(
          errorSurface.render(160).slice(1)
        );
        const errorBody = view.render(160).slice(2).join("\n");
        expect(errorBody).not.toBe("");
        expect(errorBody).toMatch(BACKGROUND_PATTERN);
        errorSurface.setPrettyBlock("", String(failure));
        expect(view.render(160).slice(2)).not.toEqual(
          errorSurface.render(160).slice(1)
        );
      } finally {
        errorSurface.dispose();
      }
    } finally {
      view.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
