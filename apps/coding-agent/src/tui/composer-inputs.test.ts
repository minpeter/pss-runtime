import {
  type Component,
  CURSOR_MARKER,
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ComposerInput } from "./bounded-input";
import { ComposerEditor } from "./composer-editor";
import { composerHeightBudget } from "./composer-height";
import { createExtensionUi } from "./extension-ui";

const widths = [1, 2, 3, 24, 48, 80, 120];
const heights = [7, 8, 11, 12, 16, 17, 24, 40, 60];
const theme = {
  borderColor: (s: string) => s,
  selectList: {
    selectedText: (s: string) => s,
    selectedPrefix: (s: string) => s,
    description: (s: string) => s,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  },
};

describe("complete composer inputs", () => {
  it("expands an open extension select after growth and retains the selected value", async () => {
    let height = 7;
    let mounted!: Component;
    const unmount = vi.fn();
    const ui = createExtensionUi({
      signal: new AbortController().signal,
      showMessage: vi.fn(),
      showStatus: () => vi.fn(),
      promptHost: {
        contentRows: () => composerHeightBudget(height) - 1,
        mount(component) {
          mounted = component;
          return unmount;
        },
      },
    });
    const result = ui.select({
      label: "SELECT_SENTINEL",
      options: Array.from({ length: 100 }, (_, i) => ({
        label: `OPTION_${i}`,
        value: String(i),
      })),
    });
    mounted.handleInput?.("\x1b[A");
    for (const rows of [7, 60, 7, 60]) {
      height = rows;
      const rendered = mounted.render(80);
      expect(rendered).toHaveLength(composerHeightBudget(height) - 1);
      expect(rendered.find((line) => line.includes("→"))).toContain(
        "OPTION_99"
      );
    }
    mounted.handleInput?.("\r");
    await expect(result).resolves.toBe("99");
    expect(unmount).toHaveBeenCalledOnce();
  });

  it.each([1, 2])(
    "uses cursor-only input mode at width %d without losing input",
    (width) => {
      const input = new ComposerInput();
      input.focused = true;
      input.setValue("draft");
      input.handleInput("Z");
      const rows = input.render(width);
      expect(stripTerminalSequences(rows[0])).toBe(" ");
      expect(rows[0]).toContain(CURSOR_MARKER);
      expect(input.getValue()).toBe("Zdraft");
    }
  );
  it("budgets actual autocomplete and preserves the selected option after resize", async () => {
    const terminal = { rows: 60 };
    const screen = new TuiMainScreen(terminal as TuiMainScreen["terminal"]);
    const editor = new ComposerEditor(screen, theme, { paddingX: 1 });
    editor.focused = true;
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const render = vi.spyOn(screen, "requestRender").mockImplementation(() => {
      if (editor.isShowingAutocomplete()) {
        resolveReady();
      }
    });
    editor.setAutocompleteProvider({
      getSuggestions: () =>
        Promise.resolve({
          prefix: "/",
          items: Array.from({ length: 20 }, (_, i) => ({
            label: `qa${i}`,
            value: `qa${i}`,
          })),
        }),
      applyCompletion: () => ({ lines: ["done"], cursorLine: 0, cursorCol: 4 }),
    });
    try {
      editor.handleInput("/");
      await ready;
      editor.handleInput("\x1b[A");
      for (const height of heights) {
        terminal.rows = height;
        for (const width of widths) {
          const rows = editor.render(width);
          expect(rows.length + 1).toBeLessThanOrEqual(
            composerHeightBudget(height)
          );
          expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(rows.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
          expect(
            rows.some((line) => stripTerminalSequences(line).startsWith("→"))
          ).toBe(true);
          if (width >= 24) {
            expect(rows.some((line) => line.includes("qa19"))).toBe(true);
          }
        }
      }
      editor.handleInput("\t");
      expect(editor.getText()).toBe("done");
    } finally {
      render.mockRestore();
    }
  });
  it.each(heights)(
    "preserves the editor cursor and scroll border within height %d",
    (height) => {
      const screen = new TuiMainScreen({
        rows: height,
      } as TuiMainScreen["terminal"]);
      const editor = new ComposerEditor(screen, theme);
      editor.focused = true;
      const e = composerHeightBudget(height) - 3;
      for (const width of widths) {
        editor.setText("\n".repeat(e - 1));
        const exact = editor.render(width);
        expect(exact.length + 1).toBeLessThanOrEqual(
          composerHeightBudget(height)
        );
        editor.setText("\n".repeat(e));
        const more = editor.render(width);
        expect(more.length + 1).toBeLessThanOrEqual(
          composerHeightBudget(height)
        );
        expect(more.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
        expect(stripTerminalSequences(more[0])).toContain("↑");
        expect(stripTerminalSequences(exact[0])).not.toContain("↑");
        expect(more.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  );

  it.each(heights)(
    "budgets multiline labels, selection and narrow input at height %d",
    async (height) => {
      let mounted: Component | undefined;
      const prompt = () => {
        if (!mounted) {
          throw new Error("Prompt not mounted");
        }
        return mounted;
      };
      const controller = new AbortController();
      const ui = createExtensionUi({
        signal: controller.signal,
        showMessage: () => undefined,
        showStatus: () => () => undefined,
        promptHost: {
          contentRows: () => composerHeightBudget(height) - 1,
          mount(component) {
            mounted = component;
            return () => undefined;
          },
        },
      });
      const result = ui.select({
        label: "QA\nLF\r\nCRLF",
        options: Array.from({ length: 100 }, (_, i) => ({
          label: `Option ${i}`,
          value: `${i}`,
        })),
      });
      for (const width of widths) {
        const rows = prompt().render(width);
        expect(rows.length + 1).toBeLessThanOrEqual(
          composerHeightBudget(height)
        );
        expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(
          rows.some((line) => stripTerminalSequences(line).startsWith("→"))
        ).toBe(true);
      }
      prompt().handleInput?.("\x1b[A");
      expect(
        prompt()
          .render(80)
          .some((line) => line.includes("Option 99"))
      ).toBe(true);
      prompt().handleInput?.("\r");
      await expect(result).resolves.toBe("99");
      const inputResult = ui.input({
        label: "QA\nLF\r\nCRLF",
        initialValue: "cursor",
      });
      Object.assign(prompt(), { focused: true });
      for (const width of widths) {
        const rows = prompt().render(width);
        expect(rows.length + 1).toBeLessThanOrEqual(
          composerHeightBudget(height)
        );
        expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(rows.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
      }
      controller.abort();
      await inputResult;
    }
  );
});
