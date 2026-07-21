import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  inputListener: undefined as ((data: string) => unknown) | undefined,
  renderCount: 0,
  started: false,
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();

  class TestTui {
    addChild(): void {
      return;
    }

    addInputListener(listener: (data: string) => unknown): () => void {
      lifecycle.inputListener = listener;
      return () => undefined;
    }

    requestRender(): void {
      if (!lifecycle.started) {
        throw new Error("render requested before TUI start");
      }
      lifecycle.renderCount += 1;
    }

    setFocus(): void {
      return;
    }

    start(): void {
      lifecycle.started = true;
      lifecycle.inputListener?.("\u0003");
    }

    stop(): void {
      return;
    }
  }

  return {
    ...original,
    ProcessTerminal: class TestTerminal {},
    TUI: TestTui,
  };
});

vi.mock("@minpeter/pss-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@minpeter/pss-runtime")>();

  return {
    ...original,
    createAgent: () =>
      Promise.resolve({
        thread: () => ({
          dispose: () => undefined,
          interrupt: () => undefined,
        }),
      }),
  };
});

import { startTui } from "./tui";

describe("TUI lifecycle", () => {
  beforeEach(() => {
    lifecycle.inputListener = undefined;
    lifecycle.renderCount = 0;
    lifecycle.started = false;
    vi.stubEnv("AI_API_KEY", "qa-key");
    vi.stubEnv("PSS_DISABLE_UPDATE_CHECK", "1");
    vi.stubEnv("TINYFISH_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not request a render before the TUI starts", async () => {
    await expect(startTui()).resolves.toBe(0);
    expect(lifecycle.renderCount).toBeGreaterThan(0);
  });
});
