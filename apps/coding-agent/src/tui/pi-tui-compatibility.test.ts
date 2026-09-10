import {
  HStack,
  Text,
  TuiMainScreen,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

describe("installed pi-tui public surface", () => {
  it("renders public layout components across resize and restores the terminal on shutdown", () => {
    let resize: () => void = () => undefined;
    const output: string[] = [];
    const noop = () => undefined;
    const terminal = {
      columns: 80,
      rows: 24,
      kittyProtocolActive: false,
      start: (_input: (data: string) => void, onResize: () => void) => {
        resize = onResize;
      },
      stop: vi.fn(),
      write: (data: string) => {
        output.push(data);
      },
      drainInput: async () => undefined,
      clearFromCursor: noop,
      clearLine: noop,
      clearScreen: noop,
      hideCursor: vi.fn(),
      showCursor: vi.fn(),
      moveBy: noop,
      setProgress: noop,
      setTitle: noop,
    };
    const screen = new TuiMainScreen(terminal);
    const row = new HStack();
    row.addChild(new Text("LAYOUT_LEFT", 0, 0));
    row.addChild(new Text("LAYOUT_RIGHT", 0, 0));
    const layout = new VStack();
    layout.addChild(row);
    layout.addChild(new Text("RESIZE_SENTINEL ".repeat(12), 0, 0));
    screen.addChild(layout);
    screen.start();
    try {
      for (const [columns, rows] of [
        [80, 24],
        [32, 10],
        [100, 32],
      ]) {
        terminal.columns = columns;
        terminal.rows = rows;
        resize();
        screen.renderNow();
        const state = screen.captureRenderState();
        expect(state.previousWidth).toBe(columns);
        expect(state.previousHeight).toBe(rows);
        expect(state.previousLines.join("\n")).toContain("RESIZE_SENTINEL");
        expect(
          state.previousLines.every((line) => visibleWidth(line) <= columns)
        ).toBe(true);
      }
      expect(output.join("")).toContain("LAYOUT_LEFT");
      expect(output.join("")).toContain("LAYOUT_RIGHT");
    } finally {
      screen.stop();
    }
    expect(terminal.hideCursor).toHaveBeenCalled();
    expect(terminal.showCursor).toHaveBeenCalledOnce();
    expect(terminal.stop).toHaveBeenCalledOnce();
  });
});
