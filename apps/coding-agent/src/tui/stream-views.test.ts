import {
  Markdown,
  type MarkdownTheme,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderColdContent } from "./cold-content";
import { AssistantStreamView } from "./stream-views";
import { TranscriptOwner } from "./transcript-owner";

const markdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

describe("AssistantStreamView terminal safety", () => {
  it("uses an extension-provided assistant text renderer", () => {
    let renderedText = "";
    const view = new AssistantStreamView(markdownTheme, {
      assistantRenderer: () => ({
        invalidate() {
          return;
        },
        render() {
          return [`plugin:${renderedText}`];
        },
        setText(text: string) {
          renderedText = text;
        },
      }),
    });

    view.appendText("rendered by extension");

    expect(view.render(120)).toContain("plugin:rendered by extension");
  });

  it("passes resolved foreground to extension renderers", () => {
    let foregroundColor: string | undefined;
    const view = new AssistantStreamView(markdownTheme, {
      assistantRenderer: (context) => {
        foregroundColor = context.foregroundColor;
        return {
          invalidate() {
            return;
          },
          render() {
            return [];
          },
          setText() {
            return;
          },
        };
      },
      foregroundColor: "#e6edf3",
    });

    view.appendText("theme");

    expect(foregroundColor).toBe("#e6edf3");
  });

  it("passes lifecycle context and disposes extension views", () => {
    const controller = new AbortController();
    let disposed = false;
    let receivedSignal: AbortSignal | undefined;
    const view = new AssistantStreamView(markdownTheme, {
      assistantRenderer: ({ signal }) => {
        receivedSignal = signal;
        return {
          dispose() {
            disposed = true;
          },
          invalidate() {
            return;
          },
          render() {
            return [];
          },
          setText() {
            return;
          },
        };
      },
      signal: controller.signal,
    });
    view.appendText("lifecycle");

    expect(receivedSignal?.aborted).toBe(false);
    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
    view.dispose();
    view.dispose();
    expect(disposed).toBe(true);
  });

  it("renders assistant and reasoning controls as visible text", () => {
    const view = new AssistantStreamView(markdownTheme);
    const payload = "hello \u001b]0;pwned\u0007";

    view.appendText(payload);
    view.appendReasoning(payload);

    const output = view.render(120).join("\n");
    expect(output.match(/\^\[\]0;pwned\^G/g)).toHaveLength(2);
    expect(output).not.toContain("\u001b]");
    expect(output).not.toContain("\u0007");
  });

  it.each([48, 100])(
    "streams full text from its first delta at width %i",
    (width) => {
      const view = new AssistantStreamView(markdownTheme);
      let text = "";
      for (const count of [20, 30, 300]) {
        const delta = Array.from(
          { length: count },
          (_, i) => `ROW_${count}_${i} ${"word ".repeat(20)}`
        ).join("\n");
        text += `${text ? "\n" : ""}${delta}`;
        view.appendText(`${count === 20 ? "" : "\n"}${delta}`);
        const live = view.render(width);
        expect(live).toEqual(
          new Markdown(text, 1, 0, markdownTheme).render(width)
        );
        expect(live.every((row) => visibleWidth(row) <= width)).toBe(true);
        expect(renderColdContent(view.captureCold(width), width)).toEqual(live);
      }
      view.dispose();
    }
  );

  it("preserves hundreds of text rows and height through sealing and resize", () => {
    let width = 100;
    const owner = new TranscriptOwner(() => width);
    const lease = owner.acquire(() => new AssistantStreamView(markdownTheme), {
      leadingSpacer: false,
      dispose: (view) => view.dispose(),
    });
    const text = Array.from(
      { length: 400 },
      (_, i) => `ROW_${i} ${"word ".repeat(20)}`
    ).join("\n");
    lease.view.appendText(text);
    for (width of [100, 48, 100]) {
      expect(owner.render(width)).toEqual(
        new Markdown(text, 1, 0, markdownTheme).render(width)
      );
    }
    const live = owner.render(width);
    owner.finish(lease);
    expect(owner.render(width)).toEqual(live);
    for (width of [48, 100]) {
      expect(owner.render(width)).toEqual(
        new Markdown(text, 1, 0, markdownTheme).render(width)
      );
    }
  });

  it("keeps text uncapped and reasoning bounded in a mixed view", () => {
    const view = new AssistantStreamView(markdownTheme);
    const source = (prefix: string) =>
      Array.from(
        { length: 20 },
        (_, i) => `${prefix}_${String(i).padStart(2, "0")}`
      ).join("\n");
    view.appendReasoning(source("THINK"));
    view.appendText(source("TEXT"));
    const live = view.render(48);
    expect(live).toHaveLength(29);
    expect(renderColdContent(view.captureCold(48), 48)).toEqual(live);
    expect(view.render(48)).toEqual(live);
    const output = live.join("\n");
    expect(output.match(/THINK_\d+/g)).toHaveLength(8);
    expect(output.match(/TEXT_\d+/g)).toHaveLength(20);
    view.dispose();
  });

  it("preserves leading indentation for Markdown code blocks", () => {
    const view = new AssistantStreamView({
      ...markdownTheme,
      codeBlock: (text) => `BLOCK:${text}`,
    });

    view.appendText("    const value = 1;");

    expect(view.render(120).join("\n")).toContain("BLOCK:");
  });
});
