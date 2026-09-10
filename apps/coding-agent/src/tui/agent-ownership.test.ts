import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import {
  type Component,
  type Container,
  CURSOR_MARKER,
  Markdown,
  stripTerminalSequences,
  type Terminal,
  type TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionHostEventBus } from "../extensions/event-bus";
import { ExtensionHostServices } from "../extensions/host-services";
import type { CodingAgentExtensionUi } from "../extensions/types";
import { createSessionManager } from "../sessions/session-manager";
import { createReadFileTool } from "../workspace-tools/read-file";
import type { AssistantRendererContext } from "./assistant-renderer";
import { createToolRenderers } from "./renderers/tool-renderers";
import type { BaseToolCallView } from "./tool-call-view";
import { ColdSnapshot, type TranscriptOwner } from "./transcript-owner";

const terminal = vi.hoisted(() => ({
  columns: 100,
  send: (_data: string): void => undefined,
  screen: undefined as TuiMainScreen | undefined,
}));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  const noop = () => undefined;
  class LocalTerminal implements Terminal {
    get columns() {
      return terminal.columns;
    }
    rows = 40;
    kittyProtocolActive = false;
    clearFromCursor = noop;
    clearLine = noop;
    clearScreen = noop;
    hideCursor = noop;
    moveBy = noop;
    setProgress = noop;
    setTitle = noop;
    showCursor = noop;
    stop = noop;
    write = noop;
    drainInput() {
      return Promise.resolve();
    }
    start(onInput: (data: string) => void) {
      terminal.send = onInput;
    }
  }
  class LocalScreen extends actual.TuiMainScreen {
    override start() {
      terminal.screen = this;
      super.start();
    }
  }
  return {
    ...actual,
    ProcessTerminal: LocalTerminal,
    TuiMainScreen: LocalScreen,
  };
});

import {
  type AgentTUIConfig,
  createAgentTUI,
  type FooterStatusBar,
} from "./agent";
import { ComposerEditor } from "./composer-editor";
import { composerHeightBudget } from "./composer-height";
import { createModelCommand } from "./model-command";
import { ModelSelectorComponent } from "./model-selector";
import { NOTICE_PULSE_MS } from "./repeated-notice";
import { retryWaitMessage } from "./retry-status";
import { createSessionCommands } from "./session-commands";
import { SessionSelectorComponent } from "./session-selector";
import { TuiSessionMachine } from "./session-state";

const BLOCK_BORDER = /[\u2502\u2500\u250C\u2510\u2514\u2518]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI token under test.
const LIME_SPINNER_FRAME = /\x1b\[38;5;118m[\u2800-\u28ff]\x1b\[0m/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI token under test.
const INDIGO_RULE = /\x1b\[38;5;99m\u2500+\x1b\[0m/u;

const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Missing TUI event")),
          2000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const idle = () => {
  const signal = gate();
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      signal.resolve();
    });
  return bounded(signal.promise);
};
const send = (text: string) => {
  for (const char of text) {
    terminal.send(char);
  }
};
const surface = () => {
  if (!terminal.screen) {
    throw new Error("TUI not mounted");
  }
  return terminal.screen;
};
const chat = () => surface().children[1] as Container;
const rows = (component: Component = chat(), width = 100) => [
  ...component.render(width),
];
const plain = () => stripTerminalSequences(rows().join("\n"));
const onRender = async (matches: () => boolean, action: () => void) => {
  const signal = gate();
  const screen = surface();
  const requestRender = screen.requestRender.bind(screen);
  const spy = vi.spyOn(screen, "requestRender").mockImplementation((force) => {
    requestRender(force);
    if (matches()) {
      signal.resolve();
    }
  });
  try {
    action();
    await bounded(signal.promise);
  } finally {
    spy.mockRestore();
  }
};
const prefix = () =>
  chat().children.map((component) => ({ component, lines: rows(component) }));
const unchanged = (snapshot: ReturnType<typeof prefix>) => {
  for (const { component, lines } of snapshot) {
    expect(rows(component)).toEqual(lines);
    expect(chat().children).toContain(component);
  }
};
function stream() {
  let next = gate<
    { event: AgentEvent; consumed: ReturnType<typeof gate<void>> } | undefined
  >();
  const returned = vi.fn();
  const run = {
    runId: "local-run",
    events: () =>
      (async function* () {
        try {
          for (;;) {
            const slot = await next.promise;
            next = gate();
            if (!slot) {
              return;
            }
            try {
              yield slot.event;
            } finally {
              slot.consumed.resolve();
            }
          }
        } finally {
          returned();
        }
      })(),
  } as AgentTurn;
  return {
    run,
    returned,
    end: () => next.resolve(undefined),
    emit: async (event: Record<string, unknown>) => {
      const consumed = gate();
      next.resolve({ event: event as AgentEvent, consumed });
      await bounded(consumed.promise);
    },
  };
}
async function fixture(extra: Partial<AgentTUIConfig> = {}) {
  const source = stream();
  const started = gate();
  const steered = gate();
  const ready = idle();
  const interrupt = vi.fn(source.end);
  const run = createAgentTUI({
    ...extra,
    thread: {
      send: () => {
        started.resolve();
        return Promise.resolve(source.run);
      },
      steer: () => {
        steered.resolve();
        return Promise.resolve(source.run);
      },
      interrupt,
    },
  });
  await ready;
  let active = false;
  return {
    ...source,
    interrupt,
    async start() {
      active = true;
      send("USER\r");
      await bounded(started.promise);
    },
    async steer() {
      send("STEERING_USER\r");
      await bounded(steered.promise);
    },
    async command(text: string) {
      const ready = idle();
      send(`${text}\r`);
      await ready;
    },
    async finish() {
      const ready = idle();
      source.end();
      await ready;
      active = false;
    },
    async close() {
      if (active && !source.returned.mock.calls.length) {
        const ready = idle();
        source.end();
        await ready;
      }
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      await bounded(run);
    },
  };
}
beforeEach(() => {
  terminal.columns = 100;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const CONTINUATION_BG = "\x1b[100m";
const continuationBlocks = () =>
  chat().children.filter((component) =>
    stripTerminalSequences(rows(component).join("\n")).includes("Continuing")
  );

describe.sequential("actual TUI transcript ownership", () => {
  it("recomputes occupied session space on actual terminal resize", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `SESSION_${i}`);
    const app = await fixture({
      setupMessages: [Array.from({ length: 25 }, () => "OCCUPIED").join("\n")],
      commands: [
        {
          name: "picker",
          description: "fixture",
          execute: () => ({
            success: true,
            action: { type: "select-session" },
          }),
        },
      ],
      sessionSelector: {
        currentSessionKey: () => ids[0],
        listSessions: async () =>
          ids.map((key) => ({
            key,
            name: key,
            cwd: "/tmp",
            createdAt: "",
            updatedAt: "",
          })),
        loadCurrentHistory: async () => [],
        switchSession: async () => undefined,
      },
    });
    const composer = surface().children.at(-1) as Container;
    try {
      await onRender(
        () => composer.children[0] instanceof SessionSelectorComponent,
        () => send("/picker\r")
      );
      terminal.send("\x1b[A");
      for (const height of [40, 60, 40]) {
        Object.assign(surface().terminal, { rows: height });
        process.stdout.emit("resize");
        const occupied = surface()
          .children.slice(0, -1)
          .reduce((sum, child) => sum + child.render(100).length, 0);
        expect(composer.render(100).length + occupied).toBeLessThanOrEqual(
          height
        );
        expect(
          composer.render(100).find((line) => line.includes("→"))
        ).toContain("SESSION_99");
      }
      const ready = idle();
      terminal.send("\x1b");
      await ready;
    } finally {
      await app.close();
    }
  });

  it("keeps startup HOT until the first content block, including model feedback", async () => {
    vi.useFakeTimers();
    let current = "MODEL_A";
    const models = {
      currentModelId: () => current,
      listModelIds: async () => ["MODEL_A", "MODEL_B", "MODEL_C"],
      switchModel: (id: string) => {
        current = id;
      },
    };
    const app = await fixture({
      header: {
        title: "LOGO_SENTINEL",
        subtitle: "MODEL_A\n/CWD_SENTINEL",
      },
      commands: [createModelCommand(models)],
      modelSelector: models,
    });
    const startup = () => surface().children[0] as Container;
    try {
      expect(
        startup().children.some((child) => child instanceof ColdSnapshot)
      ).toBe(false);
      expect(chat().children).toHaveLength(0);
      const initial = rows(startup());
      expect(initial.join("\n")).toContain(
        "\x1b[1m\x1b[38;5;99mLOGO_SENTINEL\x1b[0m"
      );
      await app.command("/model MODEL_B");
      expect(
        startup().children.some((child) => child instanceof ColdSnapshot)
      ).toBe(false);
      expect(chat().children).toHaveLength(0);
      expect(rows(startup())).toHaveLength(initial.length);
      vi.advanceTimersByTime(NOTICE_PULSE_MS);
      const hot = rows(startup());
      expect(hot).toEqual(
        initial.map((line) => line.replace("MODEL_A", "MODEL_B"))
      );
      expect(hot.join("\n")).toContain("MODEL_B");
      await app.start();
      expect(startup().children).toHaveLength(1);
      expect(startup().children[0]).toBeInstanceOf(ColdSnapshot);
      expect(rows(startup())).toEqual(hot);
      const frozen = startup().children[0];
      await app.finish();
      const cold = prefix();
      await app.command("/model MODEL_C");
      expect(startup().children[0]).toBe(frozen);
      expect(rows(startup())).toEqual(hot);
      unchanged(cold);
      expect(plain()).toContain("MODEL_C");
      expect(plain()).not.toContain("MODEL_B");
      expect(chat().children.at(-1)).not.toBeInstanceOf(ColdSnapshot);
      expect(plain().split("MODEL_C")).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it.each(["none", "setup notice"] as const)(
    "keeps exactly one raw boundary row between startup (%s) and the first block",
    async (below) => {
      const app = await fixture({
        header: { title: "LOGO", subtitle: "MODEL_A\n/CWD" },
        setupMessages: below === "none" ? [] : ["SETUP_NOTICE"],
      });
      const startup = () => surface().children[0] as Container;
      try {
        const before = rows(startup());
        await app.start();
        const header = rows(startup());
        expect(header).toEqual(before);
        const lastText =
          header.length -
          1 -
          [...header]
            .reverse()
            .findIndex((row) => stripTerminalSequences(row).trim() !== "");
        expect(stripTerminalSequences(header[lastText] ?? "")).toContain(
          below === "none" ? "Enter to submit" : "SETUP_NOTICE"
        );
        const transcript = rows(chat());
        const first = transcript.findIndex((row) => row.includes("USER"));
        expect(first).toBeGreaterThanOrEqual(0);
        // The user card's painted padding is intentional; exactly one neutral
        // (unpainted) row separates startup's last text from the card.
        const between = [
          ...header.slice(lastText + 1),
          ...transcript.slice(0, first),
        ];
        expect(between.filter((row) => row === "")).toHaveLength(1);
        expect(
          between.every((row) => stripTerminalSequences(row).trim() === "")
        ).toBe(true);
      } finally {
        await app.close();
      }
    }
  );

  it.each(["initial", "completed"] as const)(
    "shows the empty-input notice when %s with no continuation",
    async (state) => {
      const users: string[] = [];
      const complete = (): AgentTurn => ({
        async *events() {
          yield await Promise.resolve({
            type: "assistant-output-delta" as const,
            text: "COMPLETED_ANSWER",
          });
        },
      });
      const resume = vi.fn(async () => undefined);
      const ready = idle();
      const run = createAgentTUI({
        thread: {
          send: (text) => {
            users.push(text);
            return Promise.resolve(complete());
          },
          steer: async () => complete(),
          continue: resume,
          interrupt: () => undefined,
        },
      });
      try {
        await ready;
        if (state === "completed") {
          const settled = idle();
          send("ORIGINAL_USER\r");
          await settled;
          expect(plain()).toContain("COMPLETED_ANSWER");
        }
        const before = prefix();
        const settled = idle();
        send("\r");
        await settled;
        expect(plain()).toContain("Please enter a message.");
        expect(resume).toHaveBeenCalledOnce();
        expect(continuationBlocks()).toHaveLength(0);
        expect(users).toEqual(state === "completed" ? ["ORIGINAL_USER"] : []);
        unchanged(before);
      } finally {
        process.emit("SIGINT", "SIGINT");
        process.emit("SIGINT", "SIGINT");
        await bounded(run);
      }
    }
  );

  it("ignores busy empty Enter during accepted continuation without a notice", async () => {
    const source = stream();
    const admitted = gate<AgentTurn | undefined>();
    const requested = gate();
    const resume = vi.fn(() => {
      requested.resolve();
      return admitted.promise;
    });
    const ready = idle();
    const run = createAgentTUI({
      thread: {
        send: vi.fn(),
        steer: vi.fn(),
        continue: resume,
        interrupt: source.end,
      },
    });
    try {
      await ready;
      send("\r");
      await bounded(requested.promise);
      send("\r\r");
      expect(plain()).toBe("");
      await onRender(
        () => continuationBlocks().length === 1,
        () => admitted.resolve(source.run)
      );
      expect((surface().children[0] as Container).children[0]).toBeInstanceOf(
        ColdSnapshot
      );
      await source.emit({
        type: "assistant-output-delta",
        text: "LIVE_ANSWER",
      });
      const before = rows();
      send("\r\r");
      expect(rows()).toEqual(before);
      expect(plain()).not.toContain("Please enter a message.");
      expect(resume).toHaveBeenCalledOnce();
      expect(continuationBlocks()).toHaveLength(1);
      const settled = idle();
      source.end();
      await settled;
      expect(plain()).not.toContain("Please enter a message.");
    } finally {
      admitted.resolve(source.run);
      source.end();
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      await bounded(run);
    }
  });

  it("renders one padded COLD continuation card and none for idle empty Enter", async () => {
    let checkpoint = false;
    const users: string[] = [];
    const turn = (): AgentTurn => ({
      async *events() {
        checkpoint = true;
        yield await Promise.resolve({
          type: "turn-error" as const,
          message: "fixture provider failure",
        });
      },
    });
    const ready = idle();
    const run = createAgentTUI({
      thread: {
        send: (text) => {
          users.push(String(text));
          return Promise.resolve(turn());
        },
        steer: async () => turn(),
        continue: async () => (checkpoint ? turn() : undefined),
        interrupt: () => undefined,
      },
    });
    await ready;
    try {
      let settled = idle();
      send("\r");
      await settled;
      expect(continuationBlocks()).toHaveLength(0);
      expect(plain()).toContain("Please enter a message.");

      settled = idle();
      send("hi\r");
      await settled;
      expect(continuationBlocks()).toHaveLength(0);

      settled = idle();
      send("\r");
      await settled;
      const blocks = continuationBlocks();
      expect(blocks).toHaveLength(1);
      const block = blocks[0];
      expect(block).toBeInstanceOf(ColdSnapshot);
      const index = chat().children.indexOf(block);
      expect(
        stripTerminalSequences(rows(chat().children[index - 1]).join("\n"))
      ).toBe("");
      for (const width of [24, 48, 100]) {
        const rendered = rows(block, width);
        expect(rendered.length).toBe(width >= 48 ? 3 : 4);
        expect(rendered.every((line) => visibleWidth(line) === width)).toBe(
          true
        );
        expect(rendered.every((line) => line.includes(CONTINUATION_BG))).toBe(
          true
        );
        for (const line of rendered) {
          for (const span of line.split("\x1b[0m").slice(1)) {
            expect(span === "" || span.startsWith(CONTINUATION_BG)).toBe(true);
          }
        }
        const text = rendered.map((line) => stripTerminalSequences(line));
        expect(text[0].trim()).toBe("");
        expect(text.at(-1)?.trim()).toBe("");
        expect(text[1]).toContain("Continuing");
        expect(text.join("\n")).not.toMatch(BLOCK_BORDER);
      }
      expect(rows(block).join("\n")).toContain("\x1b[97m\x1b[1m");
      expect(rows(block).join("\n")).toContain("\x1b[38;5;118mContinuing");
      const userPlate = chat().children.find((component) =>
        rows(component).some(
          (line) => stripTerminalSequences(line).trim() === "hi"
        )
      );
      expect(userPlate).toBeDefined();
      for (const line of rows(userPlate as Component)) {
        expect(line.startsWith("\x1b[48;5;54m\x1b[97m")).toBe(true);
      }
      expect(rows().join("\n")).toContain("\x1b[1m\x1b[31m× ");
      expect(users).toEqual(["hi"]);
    } finally {
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      await bounded(run);
    }
  });

  it.each(["success", "failure"] as const)(
    "keeps exactly one continuation card per accepted continue on %s",
    async (outcome) => {
      let checkpoint = false;
      let continues = 0;
      const failure = (): AgentTurn => ({
        async *events() {
          checkpoint = true;
          yield await Promise.resolve({
            type: "turn-error" as const,
            message: "fixture provider failure",
          });
        },
      });
      const continued = (): AgentTurn => ({
        async *events() {
          checkpoint = outcome === "failure";
          yield await Promise.resolve(
            outcome === "failure"
              ? {
                  type: "turn-error" as const,
                  message: "still failing",
                }
              : {
                  type: "assistant-output-delta" as const,
                  text: "CONTINUED_ANSWER",
                }
          );
        },
      });
      const ready = idle();
      const run = createAgentTUI({
        thread: {
          send: () => Promise.resolve(failure()),
          steer: () => Promise.resolve(failure()),
          continue: () => {
            if (!checkpoint) {
              return Promise.resolve(undefined);
            }
            continues += 1;
            return Promise.resolve(continued());
          },
          interrupt: () => undefined,
        },
      });
      await ready;
      try {
        let settled = idle();
        send("hi\r");
        await settled;

        settled = idle();
        send("\r");
        await settled;
        expect(continues).toBe(1);
        expect(continuationBlocks()).toHaveLength(1);
        expect(plain()).not.toContain("Please enter a message.");

        settled = idle();
        send("\r");
        await settled;
        expect(continues).toBe(outcome === "failure" ? 2 : 1);
        expect(continuationBlocks()).toHaveLength(
          outcome === "failure" ? 2 : 1
        );
        if (outcome === "success") {
          expect(plain()).toContain("CONTINUED_ANSWER");
          expect(plain()).toContain("Please enter a message.");
        } else {
          expect(plain()).not.toContain("Please enter a message.");
        }
      } finally {
        process.emit("SIGINT", "SIGINT");
        process.emit("SIGINT", "SIGINT");
        await bounded(run);
      }
    }
  );

  it.each([false, true])(
    "preserves idle failed continuation with Escape (already continued: %s)",
    async (continued) => {
      let checkpoint = false;
      let requests = 0;
      const users: string[] = [];
      const failedRun = (): AgentTurn => ({
        async *events() {
          requests += 1;
          checkpoint = true;
          yield await Promise.resolve({
            type: "turn-error" as const,
            message: "fixture provider failure",
          });
        },
      });
      const ready = idle();
      const run = createAgentTUI({
        thread: {
          send: (text) => {
            users.push(String(text));
            return Promise.resolve(failedRun());
          },
          steer: async () => failedRun(),
          continue: async () => (checkpoint ? failedRun() : undefined),
          interrupt: () => {
            checkpoint = false;
          },
        },
      });
      await ready;
      try {
        let settled = idle();
        send("hi\r");
        await settled;
        if (continued) {
          settled = idle();
          send("\r");
          await settled;
        }
        expect(checkpoint).toBe(true);
        terminal.send("\x1b");
        terminal.send("\x1b");
        expect(checkpoint).toBe(true);
        settled = idle();
        send("\r");
        await settled;
        expect(requests).toBe(continued ? 3 : 2);
        expect(users).toEqual(["hi"]);
      } finally {
        process.emit("SIGINT", "SIGINT");
        process.emit("SIGINT", "SIGINT");
        await bounded(run);
      }
    }
  );

  it("lets autocomplete own Escape and keeps subsequent idle Escape harmless", async () => {
    const app = await fixture();
    const composer = surface().children.at(-1) as Container;
    const editor = composer.children[0] as ComposerEditor;
    editor.setAutocompleteProvider({
      getSuggestions: async () => ({
        prefix: "/",
        items: [{ value: "item", label: "item" }],
      }),
      applyCompletion: () => ({
        lines: ["item"],
        cursorLine: 0,
        cursorCol: 4,
      }),
    });
    try {
      await onRender(
        () => editor.isShowingAutocomplete(),
        () => terminal.send("/")
      );
      terminal.send("\x1b");
      expect(editor.isShowingAutocomplete()).toBe(false);
      expect(editor.getText()).toBe("/");
      expect(app.interrupt).not.toHaveBeenCalled();
      terminal.send("\x1b");
      expect(app.interrupt).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["model", "session"] as const)(
    "leaves focused %s picker Escape to the picker",
    async (kind) => {
      const selected = vi.fn();
      const app = await fixture({
        commands: [
          {
            name: "picker",
            description: "fixture",
            execute: () => ({
              success: true,
              action: {
                type: kind === "model" ? "select-model" : "select-session",
              },
            }),
          },
        ],
        modelSelector: {
          currentModelId: () => "one",
          listModelIds: async () => ["one", "two"],
          switchModel: selected,
        },
        sessionSelector: {
          currentSessionKey: () => "one",
          listSessions: async () => [
            {
              key: "one",
              name: "one",
              cwd: "/tmp",
              createdAt: "",
              updatedAt: "",
            },
          ],
          loadCurrentHistory: async () => [],
          switchSession: selected,
        },
      });
      try {
        const composer = surface().children.at(-1) as Container;
        await onRender(
          () =>
            composer.children[0] instanceof
            (kind === "model"
              ? ModelSelectorComponent
              : SessionSelectorComponent),
          () => send("/picker\r")
        );
        const ready = idle();
        terminal.send("\x1b");
        await ready;
        expect(composer.children[0]).toBeInstanceOf(ComposerEditor);
        expect(selected).not.toHaveBeenCalled();
        expect(app.interrupt).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("leaves extension prompt Escape and literal arrow parsing intact", async () => {
    let ui!: CodingAgentExtensionUi;
    const app = await fixture({
      onExtensionUiReady: (create) => {
        ui = create();
      },
    });
    try {
      const prompt = ui.input({ label: "fixture" });
      terminal.send("\x1b");
      await expect(bounded(prompt)).resolves.toBeUndefined();
      expect(app.interrupt).not.toHaveBeenCalled();
      terminal.send("\x1b[D");
      terminal.send("\x1b[27;1:3u");
      terminal.send("\x1b[27;1:2u");
      expect(app.interrupt).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["model", "session"] as const)(
    "enforces the complete %s cap through actual resize dispatch",
    async (kind) => {
      const ids = Array.from({ length: 100 }, (_, i) => `item-${i}-한국어`);
      const switchModel = vi.fn();
      const switchSession = vi.fn();
      const app = await fixture({
        commands: [
          {
            name: "picker",
            description: "fixture",
            execute: () => ({
              success: true,
              action: {
                type: kind === "model" ? "select-model" : "select-session",
              },
            }),
          },
        ],
        modelSelector: {
          currentModelId: () => ids[0],
          listModelIds: async () => ids,
          switchModel,
        },
        sessionSelector: {
          currentSessionKey: () => ids[0],
          listSessions: async () =>
            ids.map((key) => ({
              key,
              name: key,
              cwd: "/tmp",
              createdAt: "",
              updatedAt: "",
            })),
          loadCurrentHistory: async () => [],
          switchSession,
        },
      });
      const composer = surface().children.at(-1) as Container;
      try {
        await onRender(
          () =>
            composer.children[0] instanceof
            (kind === "model"
              ? ModelSelectorComponent
              : SessionSelectorComponent),
          () => send("/picker\r")
        );
        terminal.send("\x1b[A");
        for (const height of [60, 7, 8, 11, 12, 16, 17, 24, 40, 60]) {
          for (const width of [1, 2, 3, 24, 48, 80, 120]) {
            terminal.columns = width;
            Object.assign(surface().terminal, { rows: height });
            for (let repeat = 0; repeat < 2; repeat++) {
              process.stdout.emit("resize");
              const rendered = composer.render(width);
              expect(rendered.length).toBeLessThanOrEqual(
                composerHeightBudget(height)
              );
              expect(
                rendered.every((line) => visibleWidth(line) <= width)
              ).toBe(true);
              expect(
                rendered.some((line) => line.includes(CURSOR_MARKER))
              ).toBe(true);
              expect(
                rendered.some((line) =>
                  stripTerminalSequences(line).trimStart().startsWith("→")
                )
              ).toBe(true);
              if (width >= 24) {
                expect(rendered.find((line) => line.includes("→"))).toContain(
                  "item-99"
                );
              }
            }
          }
        }
        const ready = idle();
        terminal.send("\r");
        await ready;
        expect(
          kind === "model" ? switchModel : switchSession
        ).toHaveBeenCalledExactlyOnceWith(ids[99]);
      } finally {
        await app.close();
      }
    }
  );

  it.each(["input", "select", "confirm"] as const)(
    "unmounts revoked host %s without cancelling a replacement prompt",
    async (kind) => {
      const controller = new AbortController();
      const services = new ExtensionHostServices(
        {},
        new ExtensionHostEventBus({
          signal: controller.signal,
          timeoutMs: 2000,
        })
      );
      let replacement!: CodingAgentExtensionUi;
      const app = await fixture({
        onExtensionUiReady: (create) => {
          services.bindUi(create(), "tui");
          replacement = create();
        },
      });
      try {
        const ui = services.getServices("fixture", {
          mode: "tui",
          providers: new Map(),
          signal: controller.signal,
        }).ui;
        const composer = surface().children.at(-1) as Container;
        const editor = composer.children[0];
        const prompts = {
          input: () => ui.input({ label: "OLD_PROMPT" }),
          confirm: () => ui.confirm("OLD_PROMPT"),
          select: () =>
            ui.select({
              label: "OLD_PROMPT",
              options: [{ label: "VALUE", value: "value" }],
            }),
        };
        const request = new AbortController();
        const cancelled = ui.input({ label: "REQUEST_PROMPT" }, request.signal);
        request.abort();
        await expect(cancelled).resolves.toBeUndefined();
        expect(composer.children[0] === editor).toBe(true);
        const pending = prompts[kind]();
        expect(composer.children[0]).not.toBe(editor);
        const next = replacement.input({ label: "NEW_PROMPT" });
        const replacementView = composer.children[0];
        services.revokeInteractiveUi();
        await expect(pending).resolves.toBe(
          kind === "confirm" ? false : undefined
        );
        expect(composer.children[0]).toBe(replacementView);
        send("\x1b");
        await expect(next).resolves.toBeUndefined();
        expect(composer.children[0] === editor).toBe(true);
        send("FOCUS_RESTORED");
        expect(stripTerminalSequences(rows(composer).join("\n"))).toContain(
          "FOCUS_RESTORED"
        );
      } finally {
        controller.abort();
        await services.dispose();
        await app.close();
      }
    }
  );

  it.each(["factory", "setText", "both"] as const)(
    "preserves the current assistant text when %s synchronously notifies",
    async (phase) => {
      const contexts: AssistantRendererContext[] = [];
      const disposed = vi.fn();
      const app = await fixture({
        assistantRenderer: (ctx) => {
          contexts.push(ctx);
          const view = new Markdown("", 1, 0, ctx.markdownTheme);
          if (phase !== "setText") {
            ctx.notify("FACTORY_NOTICE");
          }
          return {
            invalidate: () => view.invalidate(),
            render: (width) => view.render(width),
            dispose: disposed,
            setText: (text) => {
              if (phase !== "factory") {
                ctx.notifyOnce("set-text", "SET_TEXT_NOTICE");
                ctx.notifyOnce("set-text", "SET_TEXT_NOTICE");
              }
              view.setText(text);
            },
          };
        },
      });
      try {
        await app.start();
        await app.emit({
          type: "assistant-output-delta",
          text: "CURRENT_TEXT",
        });
        const output = plain();
        expect(output.split("CURRENT_TEXT")).toHaveLength(2);
        for (const notice of [
          ...(phase === "setText" ? [] : ["FACTORY_NOTICE"]),
          ...(phase === "factory" ? [] : ["SET_TEXT_NOTICE"]),
        ]) {
          expect(output.split(notice)).toHaveLength(2);
          expect(output.indexOf(notice)).toBeGreaterThan(
            output.indexOf("CURRENT_TEXT")
          );
        }
        expect(contexts[0]?.signal.aborted).toBe(true);
        if (phase === "both") {
          expect(output.indexOf("SET_TEXT_NOTICE")).toBeGreaterThan(
            output.indexOf("FACTORY_NOTICE")
          );
        }
        expect(disposed).toHaveBeenCalledTimes(1);
        expect(
          chat().children.filter((child) => !(child instanceof ColdSnapshot))
        ).toHaveLength(1);
        const cold = prefix().slice(0, -1);
        contexts[0]?.notify("STALE_NOTICE");
        await app.emit({
          type: "assistant-output-delta",
          text: "LATER_TEXT",
        });
        unchanged(cold);
        expect(plain().split("CURRENT_TEXT")).toHaveLength(2);
        expect(plain().split("LATER_TEXT")).toHaveLength(2);
        expect(plain()).not.toContain("STALE_NOTICE");
        await app.finish();
        expect(contexts).toHaveLength(2);
        expect(contexts.every((ctx) => ctx.signal.aborted)).toBe(true);
        expect(disposed).toHaveBeenCalledTimes(2);
      } finally {
        await app.close();
      }
    }
  );

  it("appends a fresh renderer notice after intervening assistant deltas", async () => {
    const contexts: AssistantRendererContext[] = [];
    const app = await fixture({
      assistantRenderer: (ctx) => {
        contexts.push(ctx);
        return new Markdown("", 1, 0, ctx.markdownTheme);
      },
    });
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "BEFORE_NOTICE",
      });
      contexts.at(-1)?.notify("NOTICE_ID");
      const first = rows();
      await app.emit({
        type: "assistant-output-delta",
        text: "AFTER_NOTICE",
      });
      contexts.at(-1)?.notify("NOTICE_ID");
      expect(rows().slice(0, first.length)).toEqual(first);
      expect(plain().split("NOTICE_ID")).toHaveLength(3);
      expect(plain().indexOf("AFTER_NOTICE")).toBeGreaterThan(
        plain().indexOf("NOTICE_ID")
      );
      expect(rows().join("\n")).not.toContain("\x1b[47m\x1b[30m");
    } finally {
      await app.close();
    }
  });

  it.each(["setText", "render"] as const)(
    "retains the old transcript when replay %s fails after a valid prefix",
    async (failure) => {
      const disposed = vi.fn();
      const app = await fixture({
        assistantRenderer: (ctx) => {
          const view = new Markdown("", 1, 0, ctx.markdownTheme);
          let source = "";
          return {
            setText: (text) => {
              source = text;
              if (failure === "setText" && text === "BAD_REPLAY") {
                throw new Error("REPLAY_FAILURE");
              }
              view.setText(text);
            },
            invalidate: () => view.invalidate(),
            render: (width) => {
              if (failure === "render" && source === "BAD_REPLAY") {
                throw new Error("REPLAY_FAILURE");
              }
              return view.render(width);
            },
            dispose: disposed,
          };
        },
        commands: [
          {
            name: "replace",
            description: "fixture",
            execute: () => ({
              success: true,
              action: { type: "session", clear: true },
            }),
          },
        ],
        sessionSelector: {
          currentSessionKey: () => "new-session",
          listSessions: async () => [],
          switchSession: async () => undefined,
          loadCurrentHistory: async () => [
            { role: "user", content: "REPLAY_PREFIX" },
            { role: "assistant", content: "BAD_REPLAY" },
          ],
        },
      });
      try {
        await app.start();
        await app.emit({
          type: "assistant-output",
          text: "OLD_ANSWER",
        });
        await app.finish();
        const before = prefix();
        const epoch = (chat() as TranscriptOwner).epoch;
        await app.command("/replace");
        unchanged(before);
        expect((chat() as TranscriptOwner).epoch).toBe(epoch);
        expect(plain()).toContain("REPLAY_FAILURE");
        expect(plain()).not.toContain("REPLAY_PREFIX");
        expect(disposed).toHaveBeenCalledTimes(2);
      } finally {
        await app.close();
      }
    }
  );

  it.each(["updateHeader", "refresh-header"] as const)(
    "routes generic %s model-only refreshes to startup before COLD and a HOT notice after COLD",
    async (method) => {
      vi.useFakeTimers();
      let current = "MODEL_A";
      const header = {
        title: "LOGO_SENTINEL",
        subtitle: `${current}\n/CWD_SENTINEL\nSESSION_SENTINEL`,
      };
      const models = {
        currentModelId: () => current,
        listModelIds: async () => ["MODEL_A", "MODEL_B", "MODEL_C", "MODEL_D"],
        switchModel: (id: string) => {
          current = id;
          header.subtitle = `${id}\n/CWD_SENTINEL\nSESSION_SENTINEL`;
        },
      };
      const app = await fixture({
        header,
        modelSelector: models,
        preprocessCommand: (input, hooks) => {
          if (method !== "updateHeader") {
            return Promise.resolve(input);
          }
          models.switchModel(input.split(" ")[1]);
          hooks.updateHeader();
          return Promise.resolve(null);
        },
        commands: [
          {
            name: "refresh",
            description: "fixture",
            execute: ({ args }) => {
              models.switchModel(args[0]);
              return {
                success: true,
                action: { type: "refresh-header" },
              };
            },
          },
        ],
      });
      try {
        await app.command("/refresh MODEL_B");
        expect(chat().children).toHaveLength(0);
        expect(
          stripTerminalSequences(rows(surface().children[0]).join("\n"))
        ).toContain("MODEL_B");
        await app.start();
        await app.finish();
        const cold = prefix();
        const startup = rows(surface().children[0]);
        expect((surface().children[0] as Container).children[0]).toBeInstanceOf(
          ColdSnapshot
        );
        const shippedCommand = createModelCommand({
          ...models,
          currentModelId: () => "MODEL_A",
          switchModel: () => undefined,
        });
        let notice: Component | undefined;
        for (const id of ["MODEL_C", "MODEL_D"]) {
          await app.command(`/refresh ${id}`);
          const expected = await shippedCommand.execute({
            args: [id],
          });
          const hot = chat().children.filter(
            (child) => !(child instanceof ColdSnapshot)
          );
          expect(hot).toHaveLength(1);
          expect(stripTerminalSequences(rows(hot[0]).join("\n")).trim()).toBe(
            expected.message
          );
          if (notice) {
            expect(hot[0]).toBe(notice);
          }
          notice = hot[0];
          unchanged(cold);
          expect(rows(surface().children[0])).toEqual(startup);
          const before = rows();
          await app.command(`/refresh ${id}`);
          expect(rows()).toEqual(before);
        }
      } finally {
        await app.close();
      }
    }
  );

  it.each(["direct", "picker"] as const)(
    "updates the initial HOT model through %s without a notice and retains session notices",
    async (method) => {
      let current = "MODEL_A";
      const cwd = "/CWD_SENTINEL";
      const header = { title: "LOGO", subtitle: `${current}\n${cwd}` };
      const footer = { text: "FOOTER_A" };
      const switchModel = vi.fn((id: string) => {
        current = id;
        header.subtitle = `${id}\n${cwd}`;
        footer.text = "FOOTER_B";
      });
      const models = {
        currentModelId: () => current,
        listModelIds: async () => ["MODEL_A", "MODEL_B"],
        switchModel,
      };
      const app = await fixture({
        header,
        footer,
        modelSelector: models,
        commands: [
          createModelCommand(models),
          {
            name: "rename",
            description: "fixture",
            execute: () => {
              header.subtitle = `${current}\n${cwd}\nSESSION_RENAMED`;
              return {
                success: true,
                action: { type: "refresh-header" },
              };
            },
          },
        ],
      });
      try {
        if (method === "direct") {
          await app.command("/model MODEL_B");
        } else {
          await onRender(
            () =>
              (surface().children.at(-1) as Container).children[0] instanceof
              ModelSelectorComponent,
            () => send("/model\r")
          );
          const ready = idle();
          send("MODEL_B\r");
          await ready;
        }
        expect(current).toBe("MODEL_B");
        expect(switchModel).toHaveBeenCalledExactlyOnceWith("MODEL_B");
        expect(
          stripTerminalSequences(rows(surface().children[0]).join("\n"))
        ).toContain("MODEL_B");
        expect(chat().children).toHaveLength(0);
        expect(
          stripTerminalSequences(rows(surface().children[0]).join("\n"))
        ).toContain(cwd);
        expect(
          stripTerminalSequences(rows(surface().children.at(-1)).join("\n"))
        ).toContain("FOOTER_B");
        const noticeRows = rows();
        await app.command("/rename");
        expect(rows().slice(0, noticeRows.length)).toEqual(noticeRows);
        expect(plain()).toContain("SESSION_RENAMED");
        expect(
          stripTerminalSequences(rows(surface().children[0]).join("\n"))
        ).toContain("MODEL_B");
      } finally {
        await app.close();
      }
    }
  );

  it.each(["direct", "picker"] as const)(
    "replaces only the current HOT model notice through %s",
    async (method) => {
      vi.useFakeTimers();
      let current = "MODEL_A";
      const models = {
        currentModelId: () => current,
        listModelIds: async () => [
          "MODEL_A",
          "MODEL_B",
          "MODEL_C",
          "MODEL_ERROR",
        ],
        switchModel: (id: string) => {
          if (id === "MODEL_ERROR") {
            throw new Error("SWITCH_SENTINEL");
          }
          current = id;
        },
      };
      const app = await fixture({
        commands: [createModelCommand(models)],
        modelSelector: models,
      });
      const choose = async (id: string) => {
        if (method === "direct") {
          await app.command(`/model ${id}`);
          return;
        }
        await onRender(
          () =>
            (surface().children.at(-1) as Container).children[0] instanceof
            ModelSelectorComponent,
          () => send("/model\r")
        );
        const ready = idle();
        send(`${id}\r`);
        await ready;
      };
      try {
        await app.start();
        await app.finish();
        await choose("MODEL_B");
        await choose("MODEL_C");
        expect(
          plain()
            .split("\n")
            .filter((line) => line.includes("MODEL_"))
        ).toHaveLength(1);
        expect(plain()).not.toContain("MODEL_B");
        expect(plain()).toContain("MODEL_C");
        expect(rows().join("\n")).toContain("\x1b[47m\x1b[30m");
        await choose("MODEL_ERROR");
        expect(plain()).toContain("MODEL_C");
        expect(plain()).toContain("SWITCH_SENTINEL");
        const cold = rows();
        await choose("MODEL_B");
        expect(rows().slice(0, cold.length)).toEqual(cold);
        expect(plain()).toContain("MODEL_B");
        expect(plain()).toContain("MODEL_C");
      } finally {
        await app.close();
      }
    }
  );

  it.each(["unchanged", "error", "cancel"] as const)(
    "does not claim a picker model change on %s",
    async (outcome) => {
      vi.useFakeTimers();
      const switchModel = vi.fn(() => {
        if (outcome === "error") {
          throw new Error("SWITCH_ERROR_SENTINEL");
        }
      });
      const models = {
        currentModelId: () => "MODEL_A",
        listModelIds: async () => ["MODEL_A", "MODEL_B"],
        switchModel,
      };
      const app = await fixture({
        commands: [createModelCommand(models)],
        modelSelector: models,
      });
      try {
        const before = rows(surface().children[0]);
        await onRender(
          () =>
            (surface().children.at(-1) as Container).children[0] instanceof
            ModelSelectorComponent,
          () => send("/model\r")
        );
        const ready = idle();
        send(outcome === "cancel" ? "\x1b" : "\r");
        await ready;
        if (outcome === "error") {
          expect(plain()).toContain("SWITCH_ERROR_SENTINEL");
          expect(plain()).not.toContain("MODEL_A");
        } else {
          expect(plain().trim()).toBe("");
        }
        expect(switchModel).toHaveBeenCalledTimes(outcome === "cancel" ? 0 : 1);
        expect(rows(surface().children[0])).toEqual(before);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await app.close();
      }
    }
  );

  it.each(["direct", "picker"] as const)(
    "updates only the startup model through %s until first send, not typing or picker cancellation",
    async (method) => {
      vi.useFakeTimers();
      const header = {
        title: "LOGO_SENTINEL",
        subtitle: "MODEL_A (free tier)\n/CWD_SENTINEL\nSESSION_SENTINEL",
      };
      let current = "MODEL_A";
      const models = {
        currentModelId: () => current,
        listModelIds: async () => ["MODEL_A", "MODEL_B", "MODEL_C"],
        switchModel: vi.fn((id: string) => {
          current = id;
          header.title = "CHANGED_LOGO";
          header.subtitle = `${id} (free tier)\n/CHANGED_CWD\nCHANGED_SESSION`;
        }),
      };
      const app = await fixture({
        header,
        commands: [createModelCommand(models)],
        modelSelector: models,
      });
      const headerRows = () => rows(surface().children[0]);
      const choose = async (model: string) => {
        if (method === "direct") {
          await app.command(`/model ${model}`);
          return;
        }
        await onRender(
          () =>
            (surface().children.at(-1) as Container).children[0] instanceof
            ModelSelectorComponent,
          () => send("/model\r")
        );
        const ready = idle();
        send(`${model}\r`);
        await ready;
      };
      try {
        const initial = headerRows();
        send("UNSENT_SENTINEL");
        expect(rows(surface().children.at(-1)).join("\n")).toContain(
          "UNSENT_SENTINEL"
        );
        expect(headerRows()).toEqual(initial);
        send("\x15");
        await onRender(
          () =>
            (surface().children.at(-1) as Container).children[0] instanceof
            ModelSelectorComponent,
          () => send("/model\r")
        );
        const cancelled = idle();
        send("\x1b");
        await cancelled;
        expect(models.switchModel).not.toHaveBeenCalled();
        expect(headerRows()).toEqual(initial);
        await choose("MODEL_B");
        expect(chat().children).toHaveLength(0);
        const settled = initial.map((line) =>
          line.replace("MODEL_A", "MODEL_B")
        );
        expect(headerRows()).toEqual(
          settled.map((line) =>
            line.replace("\x1b[38;5;118mMODEL_B", "\x1b[47m\x1b[30mMODEL_B")
          )
        );
        vi.advanceTimersByTime(NOTICE_PULSE_MS);
        expect(headerRows()).toEqual(settled);
        expect(vi.getTimerCount()).toBe(0);
        await choose("MODEL_C");
        vi.advanceTimersByTime(NOTICE_PULSE_MS / 2);
        await choose("MODEL_B");
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(NOTICE_PULSE_MS / 2);
        expect(headerRows().join("\n")).toContain("\x1b[47m\x1b[30mMODEL_B");
        const wide = headerRows();
        terminal.columns = 48;
        process.stdout.emit("resize");
        expect(
          rows(surface().children[0], 48).every(
            (line) => visibleWidth(line) <= 48
          )
        ).toBe(true);
        terminal.columns = 100;
        process.stdout.emit("resize");
        expect(headerRows()).toEqual(wide);
        await app.start();
        expect(plain()).toContain("USER");
        expect(headerRows()).toEqual(settled);
        await app.finish();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(NOTICE_PULSE_MS);
        await choose("MODEL_C");
        expect(current).toBe("MODEL_C");
        expect(headerRows()).toEqual(settled);
        expect(plain()).toContain("MODEL_C");
      } finally {
        await app.close();
      }
    }
  );

  it.each(["unchanged", "error"] as const)(
    "keeps direct %s feedback without changing or pulsing the initial header",
    async (outcome) => {
      vi.useFakeTimers();
      const switchModel = vi.fn(() => {
        throw new Error("SWITCH_ERROR_SENTINEL");
      });
      const models = {
        currentModelId: () => "MODEL_A",
        listModelIds: async () => ["MODEL_A", "MODEL_B"],
        switchModel,
      };
      const app = await fixture({
        header: { title: "LOGO", subtitle: "MODEL_A\n/CWD" },
        commands: [createModelCommand(models)],
        modelSelector: models,
      });
      try {
        const before = rows(surface().children[0]);
        await app.command(
          `/model ${outcome === "unchanged" ? "MODEL_A" : "MODEL_B"}`
        );
        expect(rows(surface().children[0])).toEqual(before);
        expect(vi.getTimerCount()).toBe(0);
        expect(plain()).toContain(
          outcome === "error" ? "SWITCH_ERROR_SENTINEL" : "MODEL_A"
        );
        expect(switchModel).toHaveBeenCalledTimes(outcome === "error" ? 1 : 0);
      } finally {
        await app.close();
      }
    }
  );

  it("settles the latest startup model and removes its timer before shutdown's final frame", async () => {
    vi.useFakeTimers();
    let current = "MODEL_A";
    const models = {
      currentModelId: () => current,
      listModelIds: async () => ["MODEL_A", "MODEL_B"],
      switchModel: (id: string) => {
        current = id;
      },
    };
    const app = await fixture({
      header: { title: "LOGO", subtitle: "MODEL_A\n/CWD" },
      commands: [createModelCommand(models)],
      modelSelector: models,
    });
    try {
      await app.command("/model MODEL_B");
      expect(rows(surface().children[0]).join("\n")).toContain(
        "\x1b[47m\x1b[30mMODEL_B"
      );
      expect(chat().children).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await app.close();
    }
    expect(vi.getTimerCount()).toBe(0);
    const final = rows(surface().children[0]);
    expect(final.join("\n")).toContain("\x1b[38;5;118mMODEL_B\x1b[0m");
    const render = vi.spyOn(surface(), "requestRender");
    vi.advanceTimersByTime(NOTICE_PULSE_MS);
    expect(rows(surface().children[0])).toEqual(final);
    expect(render).not.toHaveBeenCalled();
  });

  describe.each(["startup", "command"] as const)("blank %s replay", (route) => {
    it.each([
      { name: "empty assistant", content: "" },
      { name: "whitespace assistant", content: " \t\n " },
      {
        name: "empty text part",
        content: [{ type: "text" as const, text: "" }],
      },
      {
        name: "whitespace text part",
        content: [{ type: "text" as const, text: " \t\n " }],
      },
      {
        name: "empty reasoning",
        content: [{ type: "reasoning" as const, text: "" }],
      },
      {
        name: "whitespace reasoning",
        content: [{ type: "reasoning" as const, text: " \t\n " }],
      },
    ])("keeps startup HOT for $name", async ({ content }) => {
      let current = "MODEL_A";
      const models = {
        currentModelId: () => current,
        listModelIds: async () => ["MODEL_A", "MODEL_B"],
        switchModel: (id: string) => {
          current = id;
        },
      };
      const app = await fixture({
        header: {
          title: "LOGO_SENTINEL",
          subtitle: "MODEL_A\n/CWD",
        },
        modelSelector: models,
        replayHistoryOnStartup: route === "startup",
        commands: [
          createModelCommand(models),
          {
            name: "replay",
            description: "fixture",
            execute: () => ({
              success: true,
              action: { type: "session", clear: true },
            }),
          },
        ],
        sessionSelector: {
          currentSessionKey: () => "fixture",
          listSessions: async () => [],
          switchSession: async () => undefined,
          loadCurrentHistory: async () => [{ role: "assistant", content }],
        },
      });
      try {
        if (route === "command") {
          await app.command("/replay");
        }
        const header = surface().children[0] as Container;
        expect(header.children[0]).not.toBeInstanceOf(ColdSnapshot);
        expect(chat().children).toHaveLength(0);
        await app.command("/model MODEL_B");
        expect(rows(header).join("\n")).toContain("MODEL_B");
        expect(chat().children).toHaveLength(0);
        await app.start();
        expect(header.children[0]).toBeInstanceOf(ColdSnapshot);
        await app.finish();
      } finally {
        await app.close();
      }
    });
  });

  it.each(["empty", "assistant", "tool"] as const)(
    "freezes startup only when %s replay appends actual content",
    async (kind) => {
      let current = "MODEL_A";
      const models = {
        currentModelId: () => current,
        listModelIds: async () => ["MODEL_A", "MODEL_B", "MODEL_C"],
        switchModel: (id: string) => {
          current = id;
        },
      };
      const app = await fixture({
        header: {
          title: "LOGO_SENTINEL",
          subtitle: "MODEL_A\n/CWD_SENTINEL",
        },
        modelSelector: models,
        commands: [
          createModelCommand(models),
          {
            name: "replay",
            description: "fixture",
            execute: () => ({
              success: true,
              action: { type: "session", clear: true },
            }),
          },
        ],
        sessionSelector: {
          currentSessionKey: () => "fixture",
          listSessions: async () => [],
          switchSession: async () => undefined,
          loadCurrentHistory: () => {
            if (kind === "empty") {
              return Promise.resolve([]);
            }
            return Promise.resolve([
              {
                role: "assistant",
                content:
                  kind === "assistant"
                    ? "ANSWER_SENTINEL"
                    : [
                        {
                          type: "tool-call",
                          toolCallId: "TOOL_SENTINEL",
                          toolName: "fixture",
                          input: {},
                        },
                      ],
              },
            ]);
          },
        },
      });
      try {
        await app.command("/model MODEL_B");
        await app.command("/replay");
        const header = surface().children[0] as Container;
        expect(header.children[0] instanceof ColdSnapshot).toBe(
          kind !== "empty"
        );
        const before = rows(header);
        if (kind !== "empty") {
          expect(before.join("\n")).toContain("MODEL_B");
        }
        await app.command("/model MODEL_C");
        if (kind === "empty") {
          expect(chat().children).toHaveLength(0);
          expect(rows(header).join("\n")).toContain("MODEL_C");
        } else {
          expect(rows(header)).toEqual(before);
          expect(plain()).toContain("MODEL_C");
        }
      } finally {
        await app.close();
      }
    }
  );

  it.each(["disabled", "empty", "nonempty"] as const)(
    "preserves activation and setup notices in HOT startup across %s replay",
    async (replay) => {
      vi.useFakeTimers();
      let current = "MODEL_A";
      let ui!: CodingAgentExtensionUi;
      const startup = () => surface().children[0] as Container;
      const activationFrames: string[][] = [];
      const activationFrozen: boolean[] = [];
      const models = {
        currentModelId: () => current,
        listModelIds: async () => ["MODEL_A", "MODEL_B", "MODEL_C"],
        switchModel: (id: string) => {
          current = id;
        },
      };
      const loadCurrentHistory = vi.fn(() => {
        ui.notify("REPLAY_LOADING_SENTINEL");
        activationFrames.push(rows(startup()));
        activationFrozen.push(startup().children[0] instanceof ColdSnapshot);
        return Promise.resolve(
          replay === "nonempty"
            ? [
                {
                  role: "user" as const,
                  content: "REPLAY_USER_SENTINEL",
                },
              ]
            : []
        );
      });
      const app = await fixture({
        header: {
          title: "LOGO_SENTINEL",
          subtitle: "MODEL_A\n/CWD_SENTINEL",
        },
        commands: [createModelCommand(models)],
        modelSelector: models,
        onExtensionUiReady: (createUi) => {
          ui = createUi();
          ui.notify("ACTIVATION_SENTINEL");
          activationFrames.push(rows(startup()));
          activationFrozen.push(startup().children[0] instanceof ColdSnapshot);
        },
        onSetup: () => {
          ui.notify("SETUP_CALLBACK_SENTINEL");
          activationFrames.push(rows(startup()));
          activationFrozen.push(startup().children[0] instanceof ColdSnapshot);
        },
        setupMessages: ["SETUP_MESSAGE_SENTINEL"],
        replayHistoryOnStartup: replay !== "disabled",
        sessionSelector: {
          currentSessionKey: () => "fixture",
          listSessions: async () => [],
          loadCurrentHistory,
          switchSession: async () => undefined,
        },
      });
      try {
        expect(activationFrames[0].join("\n")).toContain("ACTIVATION_SENTINEL");
        expect(activationFrames[1].join("\n")).toContain(
          "SETUP_MESSAGE_SENTINEL"
        );
        expect(activationFrames[1].join("\n")).toContain(
          "SETUP_CALLBACK_SENTINEL"
        );
        expect(activationFrozen).not.toContain(true);
        expect(loadCurrentHistory).toHaveBeenCalledTimes(
          replay === "disabled" ? 0 : 1
        );
        const initial = rows(startup());
        for (const sentinel of [
          "ACTIVATION_SENTINEL",
          "SETUP_MESSAGE_SENTINEL",
          "SETUP_CALLBACK_SENTINEL",
          ...(replay === "disabled" ? [] : ["REPLAY_LOADING_SENTINEL"]),
        ]) {
          expect(initial.join("\n").split(sentinel)).toHaveLength(2);
          expect(plain()).not.toContain(sentinel);
        }
        expect(startup().children[0] instanceof ColdSnapshot).toBe(
          replay === "nonempty"
        );
        await app.command("/model MODEL_B");
        vi.advanceTimersByTime(NOTICE_PULSE_MS);
        if (replay === "nonempty") {
          expect(rows(startup())).toEqual(initial);
          expect(plain()).toContain("REPLAY_USER_SENTINEL");
          expect(plain()).toContain("MODEL_B");
        } else {
          expect(chat().children).toHaveLength(0);
          const hot = initial.map((line) => line.replace("MODEL_A", "MODEL_B"));
          expect(rows(startup())).toEqual(hot);
          await app.start();
          expect(startup().children[0]).toBeInstanceOf(ColdSnapshot);
          expect(rows(startup())).toEqual(hot);
          await app.finish();
        }
        const frozen = startup().children[0];
        const frozenRows = rows(startup());
        await app.command("/model MODEL_C");
        ui.notify("POST_STARTUP_SENTINEL");
        expect(startup().children[0]).toBe(frozen);
        expect(rows(startup())).toEqual(frozenRows);
        expect(plain()).toContain("MODEL_C");
        expect(plain()).toContain("POST_STARTUP_SENTINEL");
      } finally {
        await app.close();
      }
    }
  );

  it("freezes the startup model after actual startup history replay before any send", async () => {
    const header = { title: "LOGO_SENTINEL", subtitle: "MODEL_A\n/CWD" };
    let current = "MODEL_A";
    const models = {
      currentModelId: () => current,
      listModelIds: async () => ["MODEL_A", "MODEL_B"],
      switchModel: (id: string) => {
        current = id;
        header.subtitle = `${id}\n/CWD`;
      },
    };
    const loadCurrentHistory = vi.fn(async () => [
      { role: "user" as const, content: "REPLAY_USER_SENTINEL" },
      { role: "assistant" as const, content: "REPLAY_ANSWER_SENTINEL" },
    ]);
    const app = await fixture({
      header,
      commands: [createModelCommand(models)],
      modelSelector: models,
      replayHistoryOnStartup: true,
      sessionSelector: {
        currentSessionKey: () => "replayed",
        listSessions: async () => [],
        loadCurrentHistory,
        switchSession: async () => undefined,
      },
    });
    try {
      expect(loadCurrentHistory).toHaveBeenCalledOnce();
      expect(plain()).toContain("REPLAY_USER_SENTINEL");
      expect(plain()).toContain("REPLAY_ANSWER_SENTINEL");
      const before = rows(surface().children[0]);
      const replayed = prefix();
      await app.command("/model MODEL_B");
      expect(current).toBe("MODEL_B");
      expect(rows(surface().children[0])).toEqual(before);
      unchanged(replayed);
    } finally {
      await app.close();
    }
  });

  it.each([48, 100])(
    "places startup metadata beside the wordmark at width %i",
    async (width) => {
      // Given: the two-row wordmark and metadata with an optional session row.
      terminal.columns = width;
      const logo = ["█🮂🮂𜷞 𜷥𜴸▀▀ 𜷥𜴸▀▀", "█🮂🮂  ▄▄𜶭𜵰 ▄▄𜶭𜵰"];
      const model = "MODEL_A";
      const cwd = `/workspace/${"nested/".repeat(8)}project`;
      const session = "SESSION_A";
      const header = {
        title: logo.join("\n"),
        subtitle: [model, cwd, session].join("\n"),
      };
      // When: the actual TUI captures its startup header.
      const app = await fixture({ header });
      try {
        const component = surface().children[0];
        const rendered = rows(component, width).map((line) =>
          stripTerminalSequences(line).trimEnd()
        );
        // Then: metadata begins exactly two cells after each unchanged logo row.
        expect(rendered[1]).toBe(` ${logo[0]}  ${model}`);
        expect(rendered[2]?.startsWith(` ${logo[1]}  /workspace/`)).toBe(true);
        expect(logo.map(visibleWidth)).toEqual([14, 14]);
        const content = rendered.join("");
        expect(content.split(model)).toHaveLength(2);
        expect(content.replaceAll(" ", "").split(cwd)).toHaveLength(2);
        expect(rendered.filter((line) => line.trim() === session)).toHaveLength(
          1
        );
        expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(
          true
        );
        // Resizing must reflow copied content, not re-read mutable header state.
        header.subtitle = "MODEL_B\n/changed\nSESSION_B";
        const resized = rows(component, 100).map((line) =>
          stripTerminalSequences(line).trimEnd()
        );
        expect(resized.slice(1, 4)).toEqual([
          ` ${logo[0]}  ${model}`,
          ` ${logo[1]}  ${cwd}`,
          ` ${session}`,
        ]);
        expect(
          rows(component, width).map((line) =>
            stripTerminalSequences(line).trimEnd()
          )
        ).toEqual(rendered);
      } finally {
        await app.close();
      }
    }
  );

  it("does not rewrite the startup header when current model/session changes", async () => {
    const header = { title: "LOGO", subtitle: "MODEL_A" };
    const app = await fixture({
      header,
      commands: [
        {
          name: "change",
          description: "fixture",
          execute: () => {
            header.subtitle = "MODEL_B_SESSION_B";
            return {
              success: true,
              message: "MODEL_B_SESSION_B",
              action: { type: "refresh-header" },
            };
          },
        },
      ],
    });
    try {
      const before = rows(surface().children[0]);
      await app.command("/change");
      expect(rows(surface().children[0])).toEqual(before);
      expect(plain()).toContain("MODEL_B_SESSION_B");
    } finally {
      await app.close();
    }
  });

  it.each(["direct", "picker", "new", "clear", "fork"] as const)(
    "retains navigation lifecycle notices after replacement via %s",
    async (method) => {
      const directory = await mkdtemp(join(tmpdir(), "navigation-notices-"));
      const manager = createSessionManager({
        cwd: "/workspace",
        directory,
        threads: createInMemoryHost().store.threads,
      });
      let current = await manager.createSession("OLD_SESSION_ID");
      const target = await manager.createSession("TARGET_SESSION_ID");
      let ui!: CodingAgentExtensionUi;
      const loading = gate();
      const release = gate();
      const switchThread = (entry: typeof current) => {
        current = entry;
        ui.notify("SWITCH_NOTICE_ID");
        return Promise.resolve();
      };
      const app = await fixture({
        commands: createSessionCommands({
          currentSession: () => current,
          ensureApproved: async () => undefined,
          manager,
          onRenamed: (entry) => {
            current = entry;
          },
          switchThread,
        }),
        currentSession: () => current,
        onExtensionUiReady: (createUi) => {
          ui = createUi();
        },
        sessionSelector: {
          currentSessionKey: () => current.key,
          listSessions: async () => [target],
          switchSession: async (key) =>
            switchThread(await manager.switchToSession(key)),
          loadCurrentHistory: async () => {
            ui.notify("LOAD_NOTICE_ID");
            loading.resolve();
            await release.promise;
            return method === "new" || method === "clear"
              ? []
              : [
                  { role: "user", content: "REPLAY_USER_ID" },
                  { role: "assistant", content: "REPLAY_ANSWER_ID" },
                ];
          },
        },
      });
      try {
        await app.start();
        await app.emit({
          type: "assistant-output-delta",
          text: "OLD_ANSWER_ID",
        });
        await app.finish();
        const before = prefix();
        const beforeRows = rows();
        const owner = chat() as TranscriptOwner;
        const epoch = owner.epoch;
        const oldSignal = owner.signal;
        oldSignal.addEventListener(
          "abort",
          () => ui.notify("RESET_NOTICE_ID"),
          { once: true }
        );
        let completed: Promise<void>;
        if (method === "picker") {
          await onRender(
            () =>
              (surface().children.at(-1) as Container).children[0] instanceof
              SessionSelectorComponent,
            () => send("/resume\r")
          );
          ui.notify("PICKER_NOTICE_ID");
          expect(plain()).toContain("PICKER_NOTICE_ID");
          completed = idle();
          send("\r");
        } else {
          completed = app.command(
            method === "direct"
              ? "/resume TARGET_SESSION_ID"
              : `/${method} NEXT_SESSION_ID`
          );
        }
        await bounded(loading.promise);
        const duringLoad = plain();
        release.resolve();
        await completed;
        const output = plain();
        expect(output).toContain("SWITCH_NOTICE_ID");
        expect(output).toContain("LOAD_NOTICE_ID");
        expect(output).toContain("RESET_NOTICE_ID");
        expect(duringLoad).not.toContain("SWITCH_NOTICE_ID");
        expect(duringLoad).not.toContain("LOAD_NOTICE_ID");
        expect(owner.epoch).toBe(epoch + 1);
        expect(oldSignal.aborted).toBe(true);
        for (const { component, lines } of before) {
          expect(rows(component)).toEqual(lines);
          expect(chat().children).not.toContain(component);
        }
        expect(beforeRows.join("\n")).toContain("OLD_ANSWER_ID");
        expect(output).not.toContain("OLD_ANSWER_ID");
        expect(output).not.toContain("PICKER_NOTICE_ID");
        const historyEnd =
          method === "new" || method === "clear"
            ? -1
            : output.indexOf("REPLAY_ANSWER_ID");
        expect(output.indexOf("SWITCH_NOTICE_ID")).toBeGreaterThan(historyEnd);
        if (method === "direct" || method === "picker") {
          expect(output.indexOf("SWITCH_NOTICE_ID")).toBeGreaterThan(
            output.indexOf("TARGET_SESSION_ID")
          );
        }
        expect(output.indexOf("LOAD_NOTICE_ID")).toBeGreaterThan(
          output.indexOf("SWITCH_NOTICE_ID")
        );
        expect(output.indexOf("RESET_NOTICE_ID")).toBeGreaterThan(
          output.indexOf("LOAD_NOTICE_ID")
        );
        ui.notify("AFTER_NAVIGATION_ID");
        expect(plain()).toContain("AFTER_NAVIGATION_ID");
      } finally {
        release.resolve();
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["switch", "load", "success"] as const)(
    "keeps startup HOT until navigation settles with %s and releases its notice buffer",
    async (result) => {
      let ui!: CodingAgentExtensionUi;
      const reached = gate();
      const release = gate();
      const app = await fixture({
        onExtensionUiReady: (createUi) => {
          ui = createUi();
        },
        commands: [
          {
            name: "navigate",
            description: "fixture",
            execute: async (input) => {
              input.onSessionNavigation?.();
              ui.notify("NAVIGATION_NOTICE_ID");
              reached.resolve();
              await release.promise;
              if (result === "switch") {
                throw new Error("SWITCH_FAILURE_ID");
              }
              return {
                success: true,
                action: { type: "session", clear: true },
              };
            },
          },
          {
            name: "ordinary",
            description: "fixture",
            execute: () => {
              ui.notify("ORDINARY_NOTICE_ID");
              expect(plain()).toContain("ORDINARY_NOTICE_ID");
              return { success: true };
            },
          },
        ],
        sessionSelector: {
          currentSessionKey: () => "target",
          listSessions: async () => [],
          switchSession: async () => undefined,
          loadCurrentHistory: () => {
            ui.notify("LOAD_NOTICE_ID");
            return result === "load"
              ? Promise.reject(new Error("LOAD_FAILURE_ID"))
              : Promise.resolve([
                  {
                    role: "assistant",
                    content: "REPLAY_ID",
                  },
                ]);
          },
        },
      });
      try {
        const header = surface().children[0] as Container;
        const owner = chat() as TranscriptOwner;
        const epoch = owner.epoch;
        const command = app.command("/navigate");
        await bounded(reached.promise);
        const frozenDuringNavigation =
          header.children[0] instanceof ColdSnapshot;
        const beforeInstall = rows();
        const epochBeforeInstall = owner.epoch;
        release.resolve();
        await command;
        expect(frozenDuringNavigation).toBe(false);
        expect(beforeInstall).toEqual([]);
        expect(epochBeforeInstall).toBe(epoch);
        expect(owner.epoch).toBe(epoch + (result === "success" ? 1 : 0));
        expect(plain().split("NAVIGATION_NOTICE_ID")).toHaveLength(2);
        if (result === "success") {
          expect(plain().indexOf("NAVIGATION_NOTICE_ID")).toBeGreaterThan(
            plain().indexOf("REPLAY_ID")
          );
        } else {
          expect(plain()).toContain(
            result === "switch" ? "SWITCH_FAILURE_ID" : "LOAD_FAILURE_ID"
          );
        }
        await app.command("/ordinary");
        ui.notify("AFTER_FAILURE_ID");
        expect(plain()).toContain("AFTER_FAILURE_ID");
      } finally {
        release.resolve();
        await app.close();
      }
    }
  );

  it.each(["direct", "picker"] as const)(
    "appends one COLD background block after replay through actual %s resume navigation",
    async (method) => {
      const target = {
        key: "cwd:/workspace#deadbeef",
        name: "RESUME_TITLE_SENTINEL",
        cwd: "/workspace",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      let current = { ...target, key: "old", name: "OLD_TITLE_SENTINEL" };
      const header = { title: "LOGO", subtitle: "MODEL_B\n/workspace" };
      const switchSession = vi.fn(() => {
        current = target;
        return Promise.resolve();
      });
      const app = await fixture({
        header,
        currentSession: () => current,
        commands: [
          {
            name: "resume",
            description: "fixture",
            execute: async () => {
              if (method === "picker") {
                return {
                  success: true,
                  action: { type: "select-session" },
                };
              }
              await switchSession();
              return {
                success: true,
                action: {
                  type: "session",
                  clear: true,
                  reason: "resume",
                },
                message: "GENERIC_DUPLICATE_SENTINEL",
              };
            },
          },
        ],
        sessionSelector: {
          currentSessionKey: () => current.key,
          listSessions: async () => [target],
          switchSession,
          loadCurrentHistory: async () => [
            { role: "user", content: "REPLAY_USER_SENTINEL" },
            {
              role: "assistant",
              content: "REPLAY_ANSWER_SENTINEL",
            },
          ],
        },
      });
      try {
        if (method === "direct") {
          await app.command("/resume");
        } else {
          await onRender(
            () =>
              (surface().children.at(-1) as Container).children[0] instanceof
              SessionSelectorComponent,
            () => send("/resume\r")
          );
          const selected = idle();
          send("\r");
          await selected;
        }
        expect(switchSession).toHaveBeenCalledOnce();
        const block = chat().children.at(-1);
        expect(block).toBeInstanceOf(ColdSnapshot);
        expect(plain()).toContain("REPLAY_USER_SENTINEL");
        expect(plain()).toContain("REPLAY_ANSWER_SENTINEL");
        expect(plain().indexOf(target.name)).toBeGreaterThan(
          plain().indexOf("REPLAY_ANSWER_SENTINEL")
        );
        expect(plain().split(target.name)).toHaveLength(2);
        expect(plain()).not.toContain("GENERIC_DUPLICATE_SENTINEL");
        for (const width of [24, 48, 100]) {
          const rendered = rows(block, width);
          const content = rendered
            .map((line) => stripTerminalSequences(line).trim())
            .filter(Boolean);
          if (width >= 48) {
            expect(content).toHaveLength(2);
            expect(content[0]).toContain(` · ${target.name}`);
            expect(content[1]).toBe("MODEL_B · /workspace");
          } else {
            expect(content.length).toBeGreaterThan(2);
          }
          expect(content.join(" ")).toContain(target.name);
          expect(content.join(" ")).toContain("MODEL_B · /workspace");
          expect(rendered.join("\n")).toContain(
            `\x1b[97m\x1b[1m${target.name}`
          );
          expect(rendered.join("\n")).toContain("\x1b[38;5;245mMODEL_B");
          expect(rendered.join("\n")).toContain(
            "\x1b[38;5;118mResumed session"
          );
          expect(rendered.join("\n")).not.toContain("\x1b[2m");
          expect(rendered.join("\n")).not.toContain("\x1b[30m");
          expect(rendered.every((line) => visibleWidth(line) === width)).toBe(
            true
          );
          expect(
            rendered.every((line) => line.includes("\x1b[48;5;235m"))
          ).toBe(true);
          for (const line of rendered) {
            const spans = line.split("\x1b[0m");
            for (const span of spans.slice(1)) {
              expect(span === "" || span.startsWith("\x1b[48;5;235m")).toBe(
                true
              );
            }
          }
          expect(stripTerminalSequences(rendered.join("\n"))).not.toMatch(
            BLOCK_BORDER
          );
        }
        const before = rows(block);
        header.subtitle = "MODEL_C\n/changed";
        current = { ...target, name: "CHANGED_TITLE" };
        expect(rows(block)).toEqual(before);
        const historical = prefix();
        await app.start();
        unchanged(historical);
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    { name: "named", sessionName: "Release notes" },
    { name: "unnamed", sessionName: undefined },
    {
      name: "UUID",
      sessionName: undefined,
      key: "12345678-1234-1234-1234-123456789abc",
      label: "#12345678",
    },
    {
      name: "long suffix",
      sessionName: undefined,
      key: "cwd:/workspace#12345678-1234-1234-1234-123456789abc",
      label: "#12345678",
    },
  ])(
    "renders a COLD resume information block for $name sessions",
    async ({ sessionName, key, label }) => {
      let currentKey = "old";
      const header = {
        title: "LOGO",
        subtitle: "MODEL_B\n/workspace/project",
      };
      const app = await fixture({
        header,
        currentSession: () => ({ key: currentKey, name: sessionName }),
        commands: [
          {
            name: "resume-fixture",
            description: "fixture",
            execute: () => {
              currentKey = key ?? "target#42";
              return {
                action: {
                  clear: true,
                  reason: "resume",
                  type: "session",
                },
                success: true,
              };
            },
          },
        ],
        sessionSelector: {
          currentSessionKey: () => currentKey,
          listSessions: async () => [],
          loadCurrentHistory: async () => [
            { role: "user", content: "REPLAYED_USER" },
          ],
          switchSession: async () => undefined,
        },
      });
      try {
        await app.command("/resume-fixture");
        const text = stripTerminalSequences(rows().join("\n"));
        expect(text).toContain("Resumed session");
        const content = rows(chat().children.at(-1))
          .map((line) => stripTerminalSequences(line).trim())
          .filter(Boolean);
        expect(content).toHaveLength(2);
        expect(content[0]).toContain(` · ${sessionName ?? label ?? "#42"}`);
        if (key) {
          expect(text).not.toContain(key);
        }
        expect(text).toContain("MODEL_B · /workspace/project");
        expect(text).not.toContain("Current session/model");
        expect(rows(chat().children.at(-1)).join("\n")).toContain(
          "\x1b[48;5;235m"
        );
        const before = rows();
        header.subtitle = "MODEL_C\n/changed";
        expect(rows()).toEqual(before);
      } finally {
        await app.close();
      }
    }
  );
  it("settles a pulsing notice before user append, not on its historical timeout", async () => {
    const callbacks: (() => void)[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 140) {
        callbacks.push(fn);
        const handle = original(fn, ms, ...args);
        clearTimeout(handle);
        return handle;
      }
      return original(fn, ms, ...args);
    }) as typeof setTimeout);
    let ui!: CodingAgentExtensionUi;
    const app = await fixture({
      onExtensionUiReady: (createUi) => {
        ui = createUi();
      },
    });
    try {
      ui.notify("NOTICE_ID");
      const normal = rows();
      ui.notify("NOTICE_ID");
      expect(rows()).not.toEqual(normal);
      await app.start();
      const cold = prefix();
      expect(rows().slice(0, normal.length)).toEqual(normal);
      for (const fn of callbacks) {
        fn();
      }
      unchanged(cold);
    } finally {
      await app.close();
    }
  });

  it.each([48, 100])(
    "separates an actual empty directory read from assistant deltas at width %i",
    async (width) => {
      terminal.columns = width;
      const workspace = await mkdtemp(join(tmpdir(), "pss-spacing-"));
      const app = await fixture({ toolRenderers: createToolRenderers() });
      try {
        await app.start();
        const input = { path: ".", offset: 1, limit: 100 };
        const tool = createReadFileTool(workspace);
        const output = await tool.execute?.(input, {
          toolCallId: "empty-directory",
          messages: [],
          context: undefined,
        });
        expect(typeof output).toBe("string");
        await app.emit({
          type: "tool-call",
          toolCallId: "empty-directory",
          toolName: "read_file",
          input,
        });
        await app.emit({
          type: "tool-result",
          toolCallId: "empty-directory",
          toolName: "read_file",
          output: { type: "text", value: output },
        });
        const toolBlock = chat().children.at(-1);
        expect(toolBlock?.render(width)).toHaveLength(1);
        const cold = prefix();
        await app.emit({
          type: "assistant-output-delta",
          text: "AFTER",
        });
        const rendered = rows(chat(), width).map(stripTerminalSequences);
        const assistantRow = rendered.findIndex((row) => row.includes("AFTER"));
        expect(rendered.slice(assistantRow - 2, assistantRow)).toEqual([
          stripTerminalSequences(toolBlock?.render(width)[0] ?? ""),
          "",
        ]);
        const count = chat().children.length;
        await app.emit({
          type: "assistant-output-delta",
          text: " CONTINUED",
        });
        expect(chat().children).toHaveLength(count);
        expect(rows(chat(), width).map(stripTerminalSequences)).toContainEqual(
          expect.stringContaining("AFTER CONTINUED")
        );
        unchanged(cold);
      } finally {
        await app.close();
        await rm(workspace, { recursive: true, force: true });
      }
    }
  );

  it.each([
    [
      "populated",
      {
        type: "text",
        value: "OK - directory\npath: .\nENTRY",
      },
    ],
    ["error", { type: "error-text", value: "READ_FAILURE" }],
  ])(
    "separates %s tools from the next assistant block",
    async (_label, output) => {
      const app = await fixture({ toolRenderers: createToolRenderers() });
      try {
        await app.start();
        await app.emit({
          type: "tool-call",
          toolCallId: "read",
          toolName: "read_file",
          input: { path: "." },
        });
        await app.emit({
          type: "tool-result",
          toolCallId: "read",
          toolName: "read_file",
          output,
        });
        const content = rows(chat().children.at(-1));
        const cold = prefix();
        await app.emit({
          type: "assistant-output-delta",
          text: "AFTER",
        });
        const rendered = rows().map(stripTerminalSequences);
        const index = rendered.findIndex((row) => row.includes("AFTER"));
        expect(rendered.slice(index - 2, index)).toEqual([
          stripTerminalSequences(content.at(-1) ?? ""),
          "",
        ]);
        unchanged(cold);
      } finally {
        await app.close();
      }
    }
  );

  it.each(["reasoning", "tool", "system", "user", "late"])(
    "keeps one boundary row from a tool to %s without rewriting COLD",
    async (next) => {
      const app = await fixture({ toolRenderers: createToolRenderers() });
      try {
        await app.start();
        await app.emit({
          type: "tool-call",
          toolCallId: "first",
          toolName: "read_file",
          input: { path: "." },
        });
        if (next !== "late") {
          await app.emit({
            type: "tool-result",
            toolCallId: "first",
            toolName: "read_file",
            output: {
              type: "text",
              value: "OK - directory\npath: .\n",
            },
          });
        }
        const before = chat().children.length;
        const last = chat().children.at(-1);
        if (next === "reasoning") {
          await app.emit({
            type: "assistant-reasoning-delta",
            text: "THINKING",
          });
        } else if (next === "tool") {
          await app.emit({
            type: "tool-call",
            toolCallId: "second",
            toolName: "read_file",
            input: { path: "second" },
          });
        } else if (next === "user") {
          await app.steer();
        } else if (next === "system") {
          await app.emit({
            type: "turn-error",
            error: "SYSTEM_FAILURE",
          });
        } else {
          await app.emit({
            type: "assistant-output-delta",
            text: "INTERLEAVED",
          });
        }
        expect(chat().children[before]?.render(100)).toEqual([""]);
        expect(chat().children[before + 1]?.render(100).length).toBeGreaterThan(
          0
        );
        // The preceding block's content is unchanged; its immutable replacement
        // may be new only when a pending tool is handed off.
        expect(chat().children[before - 1]?.render(100)).toEqual(
          last?.render(100)
        );
        const cold = prefix().slice(0, before);
        if (next === "late") {
          await app.emit({
            type: "tool-result",
            toolCallId: "first",
            toolName: "read_file",
            output: {
              type: "text",
              value: "OK - directory\npath: .\n",
            },
          });
          const continuation = chat().children.at(-1);
          expect(
            stripTerminalSequences(rows(continuation).join("\n"))
          ).toContain("Continuation (first)");
          const boundary = chat().children.length;
          await app.emit({
            type: "assistant-output-delta",
            text: "AFTER_LATE",
          });
          expect(chat().children[boundary]?.render(100)).toEqual([""]);
          expect(
            chat().children[boundary + 1]?.render(100).length
          ).toBeGreaterThan(0);
        }
        unchanged(cold);
      } finally {
        await app.close();
      }
    }
  );

  it("consumes reserved tail for the tool boundary without trimming real body blanks", async () => {
    const app = await fixture({
      toolRenderers: {
        fixture: (view, _input, output) =>
          view.setPrettyBlock(
            "HEADER",
            output === undefined ? "LONG\n".repeat(12) : "BODY\n\n"
          ),
      },
    });
    try {
      await app.start();
      await app.emit({
        type: "tool-call",
        toolCallId: "shrink",
        toolName: "fixture",
        input: {},
      });
      const height = rows().length;
      await app.emit({
        type: "tool-result",
        toolCallId: "shrink",
        toolName: "fixture",
        output: { type: "text", value: "done" },
      });
      const cold = prefix();
      const toolRows = rows(chat().children.at(-1));
      expect(
        toolRows.slice(-2).map((row) => stripTerminalSequences(row).trim())
      ).toEqual(["", ""]);
      const before = chat().children.length;
      await app.emit({ type: "assistant-output-delta", text: "NEXT" });
      expect(chat().children[before]?.render(100)).toEqual([""]);
      expect(chat().children[before + 1]?.render(100)).toHaveLength(1);
      expect(rows()).toHaveLength(height);
      const content = chat().children.flatMap((child) => child.render(100));
      expect(rows().slice(0, content.length)).toEqual(content);
      expect(
        rows()
          .slice(content.length)
          .every((row) => row === "")
      ).toBe(true);
      unchanged(cold);
    } finally {
      await app.close();
    }
  });

  it("appends reverse A/B results below already completed content", async () => {
    const app = await fixture();
    try {
      await app.start();
      for (const toolCallId of ["A", "B"]) {
        await app.emit({
          type: "tool-call",
          toolCallId,
          toolName: "fixture",
          input: { path: toolCallId },
        });
      }
      await app.emit({
        type: "tool-result",
        toolCallId: "B",
        toolName: "fixture",
        output: { type: "text", value: "RESULT_B" },
      });
      const cold = prefix();
      await app.emit({
        type: "tool-result",
        toolCallId: "A",
        toolName: "fixture",
        output: { type: "text", value: "RESULT_A" },
      });
      unchanged(cold);
      expect(plain().indexOf("RESULT_A")).toBeGreaterThan(
        plain().indexOf("RESULT_B")
      );
    } finally {
      await app.close();
    }
  });

  it("isolates completed answers even when an old custom renderer ignores abort", async () => {
    let late!: () => void;
    let context!: AssistantRendererContext;
    const app = await fixture({
      assistantRenderer: (ctx) => {
        context = ctx;
        const view = new Markdown("", 1, 0, ctx.markdownTheme);
        late = () => {
          view.setText("BUGGY_LATE_RENDER");
          ctx.requestRender();
          ctx.notify("STALE_NOTICE");
        };
        return view;
      },
    });
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "FIRST_ANSWER",
      });
      await app.emit({ type: "assistant-output", text: "FIRST_ANSWER" });
      const cold = prefix();
      late();
      unchanged(cold);
      expect(plain()).not.toContain("STALE_NOTICE");
      expect(context.signal.aborted).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("continues streaming below steering without changing its old answer", async () => {
    const app = await fixture();
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "BEFORE_STEERING",
      });
      await app.steer();
      const cold = prefix();
      await app.emit({
        type: "assistant-output-delta",
        text: "AFTER_STEERING",
      });
      unchanged(cold);
      expect(plain().indexOf("AFTER_STEERING")).toBeGreaterThan(
        plain().indexOf("STEERING_USER")
      );
    } finally {
      await app.close();
    }
  });

  it.each([48, 100])(
    "shows full text live and seals identical rows at width %i",
    async (width) => {
      const app = await fixture();
      terminal.columns = width;
      const markers = Array.from(
        { length: 16 },
        (_, i) => `CELL_${String(i).padStart(2, "0")}`
      );
      const answer = [
        "| HEADER_ID | VALUE_ID |",
        "| --- | --- |",
        ...markers.map((m) => `| ${m} | OK |`),
        "",
        "VERIFY_A",
        "",
        "VERIFY_B",
        "",
        "VERIFY_C",
      ].join("\n");
      try {
        await app.start();
        await app.emit({
          type: "tool-result",
          toolCallId: "tool",
          toolName: "fixture",
          output: { type: "text", value: "TOOL_PREFIX" },
        });
        const cold = prefix();
        await app.emit({
          type: "assistant-output-delta",
          text: answer,
        });
        const active = chat().children.at(-1);
        const live = rows(active, width);
        expect(live.length).toBeGreaterThan(8);
        expect(stripTerminalSequences(live.join("\n"))).toContain("HEADER_ID");
        await app.emit({ type: "assistant-output", text: answer });
        expect(rows(chat().children.at(-1), width)).toEqual(live);
        unchanged(cold);
        const final = stripTerminalSequences(rows(chat(), width).join("\n"));
        for (const marker of [
          "HEADER_ID",
          ...markers,
          "VERIFY_A",
          "VERIFY_B",
          "VERIFY_C",
        ]) {
          expect(final.split(marker)).toHaveLength(2);
        }
        expect(chat().children.at(-1)).toBeInstanceOf(ColdSnapshot);
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    "fallback",
    "short",
    "code",
    "late-reasoning",
    "abort",
    "error",
    "steering",
    "tools",
  ] as const)("finalizes text only at its own boundary: %s", async (mode) => {
    const app = await fixture();
    const lines = Array.from(
      { length: mode === "short" ? 2 : 24 },
      (_, i) => `TEXT_${String(i).padStart(2, "0")}`
    );
    const text =
      mode === "code"
        ? `\`\`\`ts\n${lines.join("\n")}\n\`\`\``
        : lines.join("\n");
    const reasoning = Array.from(
      { length: 20 },
      (_, i) => `THINK_${String(i).padStart(2, "0")}`
    ).join("\n");
    try {
      await app.start();
      if (mode === "late-reasoning") {
        await app.emit({
          type: "assistant-reasoning-delta",
          text: reasoning,
        });
      }
      if (mode !== "fallback") {
        await app.emit({ type: "assistant-output-delta", text });
      }
      if (mode === "late-reasoning") {
        await app.emit({
          type: "assistant-reasoning",
          text: reasoning,
        });
        expect(chat().children.at(-1)).not.toBeInstanceOf(ColdSnapshot);
      }
      const streamed = rows();
      if (mode === "abort" || mode === "error") {
        await app.emit(
          mode === "abort"
            ? { type: "turn-abort" }
            : { type: "turn-error", message: "FAIL_ID" }
        );
        await app.finish();
        for (const marker of lines) {
          expect(plain().split(marker)).toHaveLength(2);
        }
        expect(rows().slice(0, streamed.length)).toEqual(streamed);
      } else if (mode === "steering") {
        await app.steer();
        const cold = prefix();
        const continuation = text.replaceAll("TEXT", "NEXT");
        await app.emit({
          type: "assistant-output-delta",
          text: continuation,
        });
        await app.emit({
          type: "assistant-output",
          text: text + continuation,
        });
        unchanged(cold);
        expect(plain().split("TEXT_00")).toHaveLength(2);
        for (const marker of lines) {
          expect(plain().split(marker.replace("TEXT", "NEXT"))).toHaveLength(2);
        }
      } else {
        await app.emit({ type: "assistant-output", text });
        for (const marker of lines) {
          expect(plain().split(marker)).toHaveLength(2);
        }
        if (mode !== "fallback") {
          expect(rows()).toEqual(streamed);
        }
        if (mode === "late-reasoning") {
          expect(plain()).not.toContain("THINK_00");
          expect(plain().match(/THINK_\d+/g)).toHaveLength(8);
        }
        if (mode === "tools") {
          const cold = prefix();
          await app.emit({
            type: "tool-call",
            toolCallId: "next",
            toolName: "fixture",
            input: {},
          });
          await app.emit({
            type: "tool-result",
            toolCallId: "next",
            toolName: "fixture",
            output: { type: "text", value: "RESULT_ID" },
          });
          await app.emit({ type: "step-start" });
          await app.emit({
            type: "assistant-output",
            text: "FINAL_ID",
          });
          unchanged(cold);
          expect(plain().split("TEXT_00")).toHaveLength(2);
        }
      }
    } finally {
      await app.close();
    }
  });

  it("captures the full current async renderer once, then revokes it", async () => {
    const ready = gate();
    const release = gate();
    const dispose = vi.fn();
    const setText = vi.fn();
    let context!: AssistantRendererContext;
    let display = ["PENDING_ID"];
    const app = await fixture({
      assistantRenderer: (ctx) => {
        context = ctx;
        release.promise.then(() => {
          display = Array.from(
            { length: 20 },
            (_, i) => `CUSTOM_${String(i).padStart(2, "0")}`
          );
          ctx.requestRender();
          ready.resolve();
        });
        return {
          invalidate: () => undefined,
          setText,
          dispose,
          render: () => display,
        };
      },
    });
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "SOURCE_ID",
      });
      release.resolve();
      await bounded(ready.promise);
      const live = rows(chat().children.at(-1));
      expect(live).toHaveLength(20);
      await app.emit({ type: "assistant-output", text: "SOURCE_ID" });
      expect(plain().match(/CUSTOM_\d+/g)).toHaveLength(20);
      expect(rows(chat().children.at(-1))).toEqual(live);
      expect(setText).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(context.signal.aborted).toBe(true);
      const cold = prefix();
      display = ["LATE_ID"];
      context.requestRender();
      context.notify("LATE_NOTICE_ID");
      unchanged(cold);
      expect(plain()).not.toContain("LATE_ID");
    } finally {
      await app.close();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("freezes the chosen reasoning tail independently of a long answer and resize", async () => {
    const app = await fixture();
    const reasoning = Array.from(
      { length: 12 },
      (_, i) => `REASON_${i} 漢字🙂`
    ).join("\n");
    const answer = Array.from({ length: 20 }, (_, i) => `ANSWER_${i}`).join(
      "\n"
    );
    try {
      await app.start();
      await app.emit({
        type: "assistant-reasoning-delta",
        text: reasoning,
      });
      const shown = rows(chat().children[chat().children.length - 1]);
      expect(shown).toHaveLength(8);
      await app.emit({ type: "assistant-reasoning", text: reasoning });
      const cold = prefix();
      expect(rows(chat().children[chat().children.length - 1])).toEqual(shown);
      await app.emit({ type: "assistant-output-delta", text: answer });
      await app.emit({ type: "assistant-output", text: answer });
      unchanged(cold);
      const complete = rows();
      rows(chat(), 31);
      rows(chat(), 140);
      expect(rows()).toEqual(complete);
      expect(plain()).toContain("REASON_11");
      expect(plain()).not.toContain("REASON_0");
      expect(chat().children.every((c) => c instanceof ColdSnapshot)).toBe(
        true
      );
    } finally {
      await app.close();
    }
  });

  it("keeps exact canonical arguments across interleaved A/B/C continuations and isolates retained tool setters", async () => {
    const calls: {
      input: unknown;
      output: unknown;
      view: BaseToolCallView;
    }[] = [];
    const app = await fixture({
      toolRenderers: {
        fixture: (view, input, output) => {
          calls.push({ input, output, view });
          view.setPrettyBlock("fixture", String(output ?? "PENDING"));
        },
      },
    });
    const source = {
      A: { path: "A", content: "one\ntwo\n漢字\n" },
      B: { path: "B", content: "B source" },
      C: { path: "C", content: "C source" },
    };
    const encoded = Object.fromEntries(
      Object.entries(source).map(([id, input]) => [id, JSON.stringify(input)])
    );
    try {
      await app.start();
      for (const id of ["A", "B", "C"]) {
        await app.emit({
          type: "tool-call-input-start",
          toolCallId: id,
          toolName: "fixture",
        });
        await app.emit({
          type: "tool-call-input-delta",
          toolCallId: id,
          inputTextDelta: encoded[id].slice(0, 12),
        });
      }
      const old = prefix().slice(0, -1);
      for (const id of ["A", "C", "B"] as const) {
        await app.emit({
          type: "tool-call-input-delta",
          toolCallId: id,
          inputTextDelta: encoded[id].slice(12),
        });
        await app.emit({
          type: "tool-call",
          toolCallId: id,
          toolName: "fixture",
          input: source[id],
        });
      }
      unchanged(old);
      for (const id of ["C", "A", "B"] as const) {
        const before = prefix().filter(
          (entry) => entry.component instanceof ColdSnapshot
        );
        await app.emit({
          type: "tool-result",
          toolCallId: id,
          toolName: "fixture",
          output: { type: "text", value: `RESULT_${id}` },
        });
        unchanged(before);
        expect(
          [...calls].reverse().find((call) => call.output === `RESULT_${id}`)
            ?.input
        ).toEqual(source[id]);
      }
      const cold = prefix();
      for (const { view } of calls) {
        view.setPrettyBlock("STALE", "BUGGY_TOOL");
        view.clear();
      }
      unchanged(cold);
      expect(plain()).not.toContain("BUGGY_TOOL");
      expect(plain().indexOf("RESULT_C")).toBeLessThan(
        plain().indexOf("RESULT_A")
      );
      expect(plain().indexOf("RESULT_A")).toBeLessThan(
        plain().indexOf("RESULT_B")
      );
      expect(JSON.parse(encoded.A)).toEqual(source.A);
    } finally {
      await app.close();
    }
  });

  it.each(["empty", "error", "abort"] as const)(
    "seals partial output on %s terminal completion",
    async (ending) => {
      const app = await fixture();
      try {
        await app.start();
        if (ending !== "empty") {
          await app.emit({
            type: "assistant-output-delta",
            text: "PARTIAL",
          });
        }
        if (ending === "error") {
          await app.emit({
            type: "turn-error",
            message: "ERROR_SENTINEL",
          });
        }
        if (ending === "abort") {
          await app.emit({ type: "turn-abort" });
        }
        await app.finish();
        expect(chat().children.every((c) => c instanceof ColdSnapshot)).toBe(
          true
        );
        if (ending !== "empty") {
          expect(plain()).toContain("PARTIAL");
        }
        if (ending === "error") {
          expect(plain()).toContain("ERROR_SENTINEL");
        }
      } finally {
        await app.close();
      }
    }
  );

  it("retains old output on failed replacement load and revokes callbacks across explicit reset", async () => {
    const callbacks: (() => void)[] = [];
    let fail = true;
    const app = await fixture({
      assistantRenderer: (ctx) => {
        const view = new Markdown("", 1, 0, ctx.markdownTheme);
        callbacks.push(() => {
          view.setText("STALE_AFTER_RESET");
          ctx.notify("STALE_NOTICE");
          ctx.requestRender();
        });
        return view;
      },
      commands: [
        {
          name: "replace",
          description: "fixture",
          execute: () => ({
            success: true,
            action: { type: "session", clear: true },
          }),
        },
      ],
      sessionSelector: {
        currentSessionKey: () => "new-session",
        listSessions: async () => [],
        switchSession: async () => undefined,
        loadCurrentHistory: () =>
          fail
            ? Promise.reject(new Error("LOAD_FAILED"))
            : Promise.resolve([
                {
                  role: "assistant",
                  content: "REPLAY",
                },
              ]),
      },
    });
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "OLD_ANSWER",
      });
      await app.finish();
      const before = prefix();
      const epoch = (chat() as TranscriptOwner).epoch;
      await app.command("/replace");
      unchanged(before);
      expect(plain()).toContain("LOAD_FAILED");
      expect((chat() as TranscriptOwner).epoch).toBe(epoch);
      fail = false;
      await app.command("/replace");
      expect((chat() as TranscriptOwner).epoch).toBe(epoch + 1);
      const cold = prefix();
      for (const callback of callbacks) {
        callback();
      }
      unchanged(cold);
      expect(plain()).toContain("REPLAY");
      expect(plain()).not.toContain("OLD_ANSWER");
      expect(plain()).not.toContain("STALE");
    } finally {
      await app.close();
    }
  });

  it("allows enrichment only while HOT and seals before reload without clearing history", async () => {
    let complete!: () => void;
    const host = new AbortController();
    const app = await fixture({
      assistantRendererSignal: host.signal,
      assistantRenderer: (ctx) => {
        const view = new Markdown("", 1, 0, ctx.markdownTheme);
        complete = () => {
          view.setText("READY_ENRICHMENT");
          ctx.requestRender();
        };
        return view;
      },
      commands: [
        {
          name: "reload",
          description: "fixture",
          execute: () => ({
            success: true,
            action: { type: "reload" },
            message: "RELOADED",
          }),
        },
      ],
      onCommandAction: () => {
        host.abort();
        complete();
      },
    });
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "FALLBACK",
      });
      complete();
      expect(plain()).toContain("READY_ENRICHMENT");
      await app.finish();
      const cold = prefix();
      const epoch = (chat() as TranscriptOwner).epoch;
      await app.command("/reload");
      unchanged(cold);
      expect((chat() as TranscriptOwner).epoch).toBe(epoch);
    } finally {
      await app.close();
    }
  });

  it.each([false, true])(
    "freezes the %s-ready graphic or fallback without invoking its renderer on resize",
    async (readyAtSeal) => {
      let ready = false;
      let renderCount = 0;
      let context!: AssistantRendererContext;
      const asset = "\x1b_Ga=T,f=100;ASSET\x1b\\";
      const graphicRows = [asset, ...Array.from({ length: 12 }, () => "")];
      const app = await fixture({
        assistantRenderer: (ctx) => {
          context = ctx;
          const view = new Markdown("", 1, 0, ctx.markdownTheme);
          const render = view.render.bind(view);
          view.render = (width) => {
            renderCount += 1;
            return ready ? [...graphicRows] : render(width);
          };
          return view;
        },
      });
      try {
        await app.start();
        await app.emit({
          type: "assistant-output-delta",
          text: "GRAPHIC_FALLBACK",
        });
        ready = readyAtSeal;
        await app.emit({
          type: "assistant-output",
          text: "GRAPHIC_FALLBACK",
        });
        const cold = prefix();
        const count = renderCount;
        ready = true;
        context.requestRender();
        rows(chat(), 12);
        unchanged(cold);
        expect(renderCount).toBe(count);
        const frozen = chat().children[chat().children.length - 1];
        if (readyAtSeal) {
          expect(frozen.render(12)).toEqual(graphicRows);
        } else {
          expect(plain()).toContain("GRAPHIC_FALLBACK");
          expect(rows().join("\n")).not.toContain(asset);
        }
        expect(context.signal.aborted).toBe(true);
      } finally {
        await app.close();
      }
    }
  );

  it.each(["direct", "command"] as const)(
    "clears the retry countdown immediately on %s active-turn reset",
    async (reset) => {
      let ui!: CodingAgentExtensionUi;
      const app = await fixture({
        onExtensionUiReady: (create) => {
          ui = create();
        },
        commands: [
          {
            name: "new",
            description: "fixture",
            allowDuringActiveTurn: true,
            execute: () => ({
              success: true,
              message: "RETRY_RESET_DONE",
              action: { type: "session", clear: true },
            }),
          },
        ],
        sessionSelector: {
          currentSessionKey: () => "new",
          listSessions: async () => [],
          switchSession: async () => undefined,
          loadCurrentHistory: async () => [],
        },
      });
      try {
        await app.start();
        const composer = surface().children[3] as Container;
        const footer = composer.children[1] as FooterStatusBar;
        const baseMessage = footer.getForegroundMessage();
        const intervals = vi.spyOn(globalThis, "setInterval");
        const clearInterval = vi.spyOn(globalThis, "clearInterval");
        vi.spyOn(Date, "now").mockReturnValue(10_000);
        const scheduled = {
          type: "model-retry",
          phase: "scheduled",
          attempt: 1,
          attemptId: "old-step",
          delayMs: 4000,
          remainingRetries: 2,
          retryAt: 14_000,
        };
        await app.emit(scheduled);
        expect(footer.getForegroundMessage()).toBe(
          retryWaitMessage({ ...scheduled, remainingMs: 4000 })
        );
        const tickerIndex = intervals.mock.calls.findIndex(
          ([, delay]) => delay === 1000
        );
        expect(tickerIndex).toBeGreaterThanOrEqual(0);
        const ticker = intervals.mock.results[tickerIndex].value;

        if (reset === "direct") {
          (chat() as TranscriptOwner).reset("session-navigation");
        } else {
          await onRender(
            () => plain().includes("RETRY_RESET_DONE"),
            () => send("/new\r")
          );
        }
        // The source is still blocked: cleanup cannot depend on another event.
        expect(app.returned).not.toHaveBeenCalled();
        expect(clearInterval).toHaveBeenCalledWith(ticker);
        expect(footer.getForegroundMessage()).toBe(baseMessage);

        const clear = ui.status("NEW_EPOCH_STATUS");
        vi.advanceTimersByTime(5000);
        expect(footer.getForegroundMessage()).toBe("NEW_EPOCH_STATUS");
        clear();
        expect(footer.getForegroundMessage()).toBe(baseMessage);

        ui.status("NEW_EPOCH_STATUS");
        const ready = idle();
        await app.emit(scheduled);
        await ready;
        expect(app.returned).toHaveBeenCalledTimes(1);
        expect(footer.getForegroundMessage()).toBe("NEW_EPOCH_STATUS");
      } finally {
        await app.close();
      }
    }
  );

  it("does not clear an unrelated foreground label on a reset without retry", async () => {
    const app = await fixture();
    try {
      await app.start();
      await app.emit({
        type: "assistant-reasoning-delta",
        text: "REASONING",
      });
      const composer = surface().children[3] as Container;
      const footer = composer.children[1] as FooterStatusBar;
      const message = footer.getForegroundMessage();
      const publish = vi.spyOn(footer, "setForegroundMessage");
      (chat() as TranscriptOwner).reset("session-navigation");
      expect(publish).not.toHaveBeenCalled();
      expect(footer.getForegroundMessage()).toBe(message);
    } finally {
      await app.close();
    }
  });

  it("ignores an old stream after an explicit active-turn reset and cancels old prompts/status", async () => {
    let ui!: CodingAgentExtensionUi;
    const app = await fixture({
      onExtensionUiReady: (create) => {
        ui = create();
      },
      commands: [
        {
          name: "new",
          description: "fixture",
          allowDuringActiveTurn: true,
          execute: () => ({
            success: true,
            message: "RESET_DONE",
            action: { type: "session", clear: true },
          }),
        },
      ],
      sessionSelector: {
        currentSessionKey: () => "new",
        listSessions: async () => [],
        switchSession: async () => undefined,
        loadCurrentHistory: async () => [
          { role: "assistant", content: "NEW_EPOCH" },
        ],
      },
    });
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "OLD_STREAM",
      });
      const epoch = (chat() as TranscriptOwner).epoch;
      await onRender(
        () => plain().includes("RESET_DONE"),
        () => send("/new\r")
      );
      expect((chat() as TranscriptOwner).epoch).toBe(epoch + 1);
      const afterReset = rows();
      const endTurn = TuiSessionMachine.prototype.endTurn;
      const ended = gate();
      vi.spyOn(TuiSessionMachine.prototype, "endTurn").mockImplementationOnce(
        function (this: TuiSessionMachine, run) {
          endTurn.call(this, run);
          ended.resolve();
        }
      );
      await app.emit({
        type: "assistant-output-delta",
        text: "STALE_DELTA",
      });
      expect(app.returned).toHaveBeenCalledTimes(1);
      await bounded(ended.promise);
      expect(rows()).toEqual(afterReset);
      const prompt = ui.input({ label: "OLD_EPOCH_PROMPT" });
      ui.status("OLD_EPOCH_STATUS");
      (chat() as TranscriptOwner).reset("session-navigation");
      await expect(prompt).resolves.toBeUndefined();
      expect(
        stripTerminalSequences(surface().render(100).join("\n"))
      ).not.toContain("OLD_EPOCH_STATUS");
    } finally {
      await app.close();
    }
  });

  it("freezes before multiline rejected steering and resumes below the rejection", async () => {
    const app = await fixture({
      preprocessUserInput: async (input) =>
        input === "STEERING_USER"
          ? { success: false, error: "REJECT_ONE\nREJECT_TWO" }
          : undefined,
    });
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "BEFORE_REJECTION",
      });
      await onRender(
        () => plain().includes("REJECT_TWO"),
        () => send("STEERING_USER\r")
      );
      const cold = prefix().filter(
        (entry) => entry.component instanceof ColdSnapshot
      );
      await app.emit({
        type: "assistant-output-delta",
        text: "AFTER_REJECTION",
      });
      unchanged(cold);
      expect(plain().indexOf("AFTER_REJECTION")).toBeGreaterThan(
        plain().indexOf("REJECT_TWO")
      );
    } finally {
      await app.close();
    }
  });

  it("hands off even empty tool input and freezes the pending card on abort", async () => {
    const app = await fixture();
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "PARTIAL_REASON",
      });
      await app.emit({
        type: "tool-call-input-start",
        toolCallId: "EMPTY_A",
        toolName: "fixture",
      });
      const cold = prefix().filter(
        (entry) => entry.component instanceof ColdSnapshot
      );
      await app.emit({
        type: "tool-call-input-start",
        toolCallId: "EMPTY_B",
        toolName: "fixture",
      });
      unchanged(cold);
      await app.emit({ type: "turn-abort" });
      expect(chat().children.every((c) => c instanceof ColdSnapshot)).toBe(
        true
      );
    } finally {
      await app.close();
    }
  });

  it.each(["error-text", "execution-denied"] as const)(
    "appends a late %s result without changing the old tool",
    async (type) => {
      const app = await fixture();
      try {
        await app.start();
        await app.emit({
          type: "tool-call",
          toolCallId: "A",
          toolName: "fixture",
          input: {},
        });
        await app.emit({
          type: "assistant-output",
          text: "LATER_ANSWER",
        });
        const cold = prefix();
        await app.emit({
          type: "tool-result",
          toolCallId: "A",
          toolName: "fixture",
          output: {
            type,
            value: "ERROR_RESULT",
            reason: "DENIED_RESULT",
          },
        });
        unchanged(cold);
        expect(chat().children.every((c) => c instanceof ColdSnapshot)).toBe(
          true
        );
      } finally {
        await app.close();
      }
    }
  );

  it("keeps concurrent extension prompts in the HOT composer, restores focus and preserves COLD", async () => {
    let ui!: CodingAgentExtensionUi;
    let secondUi!: CodingAgentExtensionUi;
    const firstHost = new AbortController();
    const secondHost = new AbortController();
    const app = await fixture({
      onExtensionUiReady: (create) => {
        ui = create(firstHost.signal);
        secondUi = create(secondHost.signal);
      },
    });
    try {
      await app.start();
      await app.emit({ type: "assistant-output-delta", text: "ANSWER" });
      await app.finish();
      const cold = prefix();
      const overlay = vi.spyOn(surface(), "showOverlay");
      const one = ui.input({
        label: "FIRST_PROMPT",
        initialValue: "draft",
      });
      const two = secondUi.select({
        label: "SECOND_PROMPT",
        options: [
          { label: "ONE", value: "one" },
          { label: "TWO", value: "two" },
        ],
      });
      const composer = surface().children.at(-1) as Container;
      expect(stripTerminalSequences(rows(composer).join("\n"))).toContain(
        "SECOND_PROMPT"
      );
      firstHost.abort();
      await expect(one).resolves.toBeUndefined();
      expect(stripTerminalSequences(rows(composer).join("\n"))).toContain(
        "SECOND_PROMPT"
      );
      terminal.send("\x1b[13;1:3u");
      expect(composer.children[0]).not.toBeUndefined();
      terminal.send("\x1b[B");
      send("\r");
      await expect(two).resolves.toBe("two");
      unchanged(cold);
      expect(overlay).not.toHaveBeenCalled();
      expect(composer.children.at(-1)?.render(100)).toHaveLength(1);
      const confirm = ui.confirm("ABORTED");
      await expect(confirm).resolves.toBe(false);
      const input = secondUi.input({ label: "CANCEL_PROMPT" });
      send("\x03");
      await expect(input).resolves.toBeUndefined();
    } finally {
      firstHost.abort();
      secondHost.abort();
      await app.close();
    }
  });

  it("paints the Unit-01 palette on the user plate, assistant markdown, and spinner", async () => {
    const app = await fixture();
    try {
      await app.start();
      const footer = surface().children.at(-1) as Container;
      // Live status: lime braille frame in the one-row footer.
      expect(rows(footer).join("\n")).toMatch(LIME_SPINNER_FRAME);
      await app.emit({
        type: "assistant-output-delta",
        text: "# Sync\n\nInline `code` here.\n\n- bullet\n\n---\n",
      });
      await app.finish();
      const text = rows().join("\n");
      const userPlate = chat().children.find((component) =>
        rows(component).some(
          (line) => stripTerminalSequences(line).trim() === "USER"
        )
      );
      expect(userPlate).toBeDefined();
      for (const line of rows(userPlate as Component)) {
        expect(line.startsWith("\x1b[48;5;54m\x1b[97m")).toBe(true);
        expect(visibleWidth(line)).toBe(100);
      }
      expect(text).toContain("\x1b[1m\x1b[38;5;118m");
      expect(text).toContain("\x1b[38;5;118mcode\x1b[0m");
      expect(text).toContain("\x1b[38;5;99m- \x1b[0m");
      expect(text).toMatch(INDIGO_RULE);
      expect(text).not.toContain("\x1b[36m");
      expect(text).not.toContain("\x1b[96m");
    } finally {
      await app.close();
    }
  });
});
