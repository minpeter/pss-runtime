import {
  Container,
  Markdown,
  type MarkdownTheme,
  stripTerminalSequences,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { selectMarkdownTables } from "./cold-table";
import { SnapshotMarkdown } from "./snapshot-views";
import { AssistantStreamView } from "./stream-views";
import { BaseToolCallView } from "./tool-call-view";
import { ColdSnapshot } from "./transcript-owner";

const identity = (text: string) => text;
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

describe("Cubic render regressions", () => {
  it.each([
    "\x1b_Ga=T,f=100;ASSET\x1b\\",
    "\x1b]1337;File=inline=1:ASSET\x07",
    "\x1bPqASSET\x1b\\",
  ])(
    "keeps custom graphics and reserved rows separate and atomic: %j",
    (payload) => {
      const view = new BaseToolCallView("graphics", "custom", theme);
      try {
        const body = [
          payload,
          ...Array.from({ length: 12 }, () => ""),
          "AFTER",
        ];
        view.setPrettyBlock("HEADER", body.join("\n"), { allowAnsi: true });
        const rows = view.render(24);
        expect(rows).toHaveLength(body.length + 2);
        expect(rows.every((row) => !row.includes("\n"))).toBe(true);
        expect(rows.slice(2).map(visibleWidth)).toEqual(body.map(() => 24));
        expect(rows[2]).toContain(payload);
        expect(stripTerminalSequences(rows.at(-1) ?? "").trim()).toBe("AFTER");
        const snapshot = ColdSnapshot.capture(view, 24);
        for (const width of [12, 24, 48]) {
          expect(snapshot.render(width).slice(2)).toEqual(rows.slice(2));
        }
      } finally {
        view.dispose();
      }
    }
  );

  it("captures opaque descendants once and commits the same frame at every width", () => {
    let frame = 0;
    const render = vi.fn(() => [`FRAME_${++frame}`]);
    const group = new Container();
    group.addChild({ render, invalidate: vi.fn() });
    const snapshot = ColdSnapshot.capture(group, 24);
    expect(render).toHaveBeenCalledTimes(1);
    expect(snapshot.render(24)).toEqual(["FRAME_1"]);
    expect(snapshot.render(48)).toEqual(["FRAME_1"]);
  });

  it.each(["CUSTOM_HEADER", "\x1b_Ga=T,f=100;ASSET\x1b\\"])(
    "preserves opaque Container render overrides through assistant sealing: %j",
    (header) => {
      class CustomAssistant extends Container {
        readonly body = new Text("", 0, 0);
        constructor() {
          super();
          this.addChild(this.body);
        }
        setText(text: string): void {
          this.body.setText(text);
        }
        override render(width: number): string[] {
          return [header, ...super.render(width)];
        }
      }
      const custom = new CustomAssistant();
      const render = vi.spyOn(custom, "render");
      const view = new AssistantStreamView(theme, {
        assistantRenderer: () => custom,
      });
      view.appendText("BODY");
      const hot = view.render(24);
      expect(hot[0]).toBe(header);
      render.mockClear();
      const snapshot = ColdSnapshot.capture(view, 24);
      expect(snapshot.render(24)).toEqual(hot);
      expect(render).toHaveBeenCalledTimes(1);
      view.dispose();
      custom.body.setText("LATE_MUTATION");
      for (const width of [48, 80, 24]) {
        expect(snapshot.render(width)).toEqual(hot);
      }
      expect(render).toHaveBeenCalledTimes(1);
    }
  );

  it("captures syntax highlighting once per block, including committed rows", () => {
    const highlightCode = vi.fn((code: string) =>
      code.split("\n").map((line) => `\x1b[31m${line}\x1b[0m`)
    );
    const view = new SnapshotMarkdown("```ts\nconst value = 1;\n```", 1, 0, {
      ...theme,
      highlightCode,
    });
    const snapshot = ColdSnapshot.capture(view, 24);
    expect(highlightCode).toHaveBeenCalledTimes(1);
    for (const width of [12, 24, 48]) {
      expect(snapshot.render(width).join("")).toContain("\x1b[31m");
    }
    expect(highlightCode).toHaveBeenCalledTimes(1);
  });

  it("still selects real styled Markdown table cells with wide glyphs and literal pipes", () => {
    const source = "| Name | Value |\n| --- | --- |\n| 漢字 | a\\|b |";
    const styled = {
      ...theme,
      bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
    };
    const natural = new Markdown(source, 0, 0, styled).render(80);
    const actual = new Markdown(source, 1, 0, styled).render(24);
    const selected = selectMarkdownTables(natural, actual, 24, 3, 1);
    expect(selected).toMatchObject({
      kind: "selected",
      content: {
        kind: "group",
        children: [{ kind: "table", rows: [{ cells: ["漢字", "a|b"] }] }],
      },
    });
  });

  it.each([
    { rows: ["┌─────┐", "│ ART │", "└─────┘"] },
    { rows: ["┌─────┐", "│ ART │", "├────┤", "│ END │", "└─────┘"] },
    { rows: ["┌─────┐", "│ ART │", "├─────┤", "│ END", "└─────┘"] },
    { rows: ["┌─────┐", "│ ART │", "├─────┤", "│ END │", "└────┘"] },
  ])("does not decode non-table box art as cell data: $rows", ({ rows }) => {
    expect(selectMarkdownTables(rows, rows, 24, 2, 0)).toBeUndefined();
  });
});
