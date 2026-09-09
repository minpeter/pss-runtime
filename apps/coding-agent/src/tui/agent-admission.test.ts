import {
  Container,
  StdinBuffer,
  type Terminal,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import { type AgentTurn, createAgent } from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentExtensionUi } from "../extensions/types";

const terminal = vi.hoisted(() => ({
  send: (_data: string): void => undefined,
  screen: undefined as TuiMainScreen | undefined,
}));
vi.mock("@earendil-works/pi-tui", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-tui")>();
  const noop = () => undefined;
  class TestTerminal implements Terminal {
    columns = 100;
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
    start(input: (data: string) => void) {
      terminal.send = input;
    }
  }
  class Screen extends actual.TuiMainScreen {
    override start() {
      terminal.screen = this;
      super.start();
    }
  }
  return { ...actual, ProcessTerminal: TestTerminal, TuiMainScreen: Screen };
});

import { type AgentTUIConfig, createAgentTUI, FooterStatusBar } from "./agent";
import { ComposerEditor } from "./composer-editor";
import { TuiSessionMachine } from "./session-state";
import { TranscriptOwner } from "./transcript-owner";

const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Expected lifecycle event")),
          500
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const idle = () => {
  const ready = gate();
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      ready.resolve();
    });
  return ready.promise;
};
const send = (text: string) => {
  for (const char of text) {
    terminal.send(char);
  }
};
const exit = () => {
  process.emit("SIGINT", "SIGINT");
  process.emit("SIGINT", "SIGINT");
};
const SPINNER_PATTERN = /[\u2800-\u28ff]/u;
const emptyRun = (): AgentTurn => ({
  async *events() {
    yield* [];
  },
});
const stream = () => {
  const entered = gate();
  const end = gate();
  return {
    entered,
    end,
    run: {
      async *events() {
        entered.resolve();
        await end.promise;
        yield* [];
      },
    } satisfies AgentTurn,
  };
};
const components = () => {
  const composer = terminal.screen?.children.at(-1);
  if (!(composer instanceof Container)) {
    throw new Error("Missing composer");
  }
  const editor = composer.children[0];
  const footer = composer.children[1];
  if (
    !(editor instanceof ComposerEditor && footer instanceof FooterStatusBar)
  ) {
    throw new Error("Missing input surface");
  }
  return { editor, footer };
};
const thread = () => ({
  send: vi.fn(async () => emptyRun()),
  steer: vi.fn(async () => emptyRun()),
  continue: vi.fn(async () => undefined as AgentTurn | undefined),
  interrupt: vi.fn(),
});
const whenUnlocked = () => {
  const unlocked = gate();
  const screen = terminal.screen;
  if (!screen) {
    throw new Error("Missing screen");
  }
  const original = screen.requestRender.bind(screen);
  const spy = vi.spyOn(screen, "requestRender").mockImplementation((force) => {
    original(force);
    if (!components().editor.disableSubmit) {
      spy.mockRestore();
      unlocked.resolve();
    }
  });
  return unlocked.promise;
};
afterEach(() => {
  vi.restoreAllMocks();
});

describe.sequential("TUI admission ownership", () => {
  it("aborts real runtime admission during storage load before storage resolves", async () => {
    const host = createInMemoryHost();
    const loading = gate();
    const release = gate();
    const modelCall = vi.fn(() => {
      throw new Error("unexpected provider");
    });
    const agent = await createAgent({
      host,
      model: new MockLanguageModelV4({ doStream: modelCall }),
    });
    const realThread = agent.thread("exit-admission");
    const original = host.store.threads.load.bind(host.store.threads);
    vi.spyOn(host.store.threads, "load").mockImplementation(async (key) => {
      loading.resolve();
      await release.promise;
      return original(key);
    });
    const continuation = vi.spyOn(realThread, "continue");
    const ready = idle();
    const run = createAgentTUI({ thread: realThread });
    try {
      await bounded(ready);
      send("\r");
      await bounded(loading.promise);
      const signal = continuation.mock.calls[0]?.[0]?.signal;
      expect(signal?.aborted).toBe(false);
      exit();
      await bounded(run);
      expect(signal?.aborted).toBe(true);
      expect(modelCall).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      exit();
      await bounded(run);
      await agent.dispose();
    }
  });

  it("silently refuses continuation while an unmatched real runtime turn is busy", async () => {
    const generating = gate();
    const release = gate();
    const agent = await createAgent({
      host: createInMemoryHost(),
      model: new MockLanguageModelV4({
        doStream: async () => {
          generating.resolve();
          await release.promise;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
          };
        },
      }),
    });
    const realThread = agent.thread("external-busy");
    const external = await realThread.send("original");
    const completed = (async () => {
      for await (const _part of external.events()) {
        /* Drain the real external turn. */
      }
    })();
    await bounded(generating.promise);
    const ready = idle();
    const run = createAgentTUI({ thread: realThread });
    try {
      await bounded(ready);
      const transcript = terminal.screen?.children.find(
        (component) => component instanceof TranscriptOwner
      );
      if (!(transcript instanceof TranscriptOwner)) {
        throw new Error("Missing transcript");
      }
      const notice = vi.spyOn(transcript, "acquire");
      const settled = idle();
      send("\r");
      await bounded(settled);
      expect(notice).not.toHaveBeenCalled();
      expect(components().editor.disableSubmit).toBe(false);
      expect(components().footer.render(100).join("")).not.toMatch(
        SPINNER_PATTERN
      );
    } finally {
      release.resolve();
      realThread.interrupt();
      exit();
      await bounded(run);
      await completed;
      await agent.dispose();
    }
  });

  it("ignores only the runtime busy code and releases admission feedback", async () => {
    const api = thread();
    api.continue.mockRejectedValue(
      Object.assign(new Error("unrelated wording"), {
        code: "THREAD_CONTINUATION_BUSY",
      })
    );
    const ready = idle();
    const run = createAgentTUI({ thread: api });
    try {
      await bounded(ready);
      const transcript = terminal.screen?.children.find(
        (component) => component instanceof TranscriptOwner
      );
      if (!(transcript instanceof TranscriptOwner)) {
        throw new Error("Missing transcript");
      }
      const acquired = vi.spyOn(transcript, "acquire");
      const settled = idle();
      send("\r");
      await bounded(settled);
      expect(acquired).not.toHaveBeenCalled();
      expect(components().editor.disableSubmit).toBe(false);
      expect(components().footer.render(100).join("")).not.toMatch(
        SPINNER_PATTERN
      );
      api.continue.mockRejectedValue(
        new Error("Thread has active or queued work.")
      );
      const next = idle();
      send("\r");
      await bounded(next);
      expect(acquired).toHaveBeenCalledOnce();
    } finally {
      exit();
      await bounded(run);
    }
  });

  it.each(["success", "undefined", "reject"] as const)(
    "owns pending feedback until %s admission and appends only accepted cards",
    async (outcome) => {
      const admission = gate<AgentTurn | undefined>();
      const entered = gate();
      const source = stream();
      const api = thread();
      api.continue.mockImplementation(() => {
        entered.resolve();
        return admission.promise;
      });
      const ready = idle();
      const run = createAgentTUI({ thread: api });
      try {
        await bounded(ready);
        send("\r");
        await bounded(entered.promise);
        const transcript = terminal.screen?.children.find(
          (component) => component instanceof TranscriptOwner
        );
        if (!(transcript instanceof TranscriptOwner)) {
          throw new Error("Missing transcript");
        }
        const appended = vi.spyOn(transcript, "addChild");
        send("\r\r");
        expect(api.continue).toHaveBeenCalledOnce();
        expect(components().footer.render(100).join("")).toMatch(
          SPINNER_PATTERN
        );
        expect(appended).not.toHaveBeenCalled();
        const settled = idle();
        if (outcome === "reject") {
          admission.reject(new Error("fixture admission failure"));
        } else {
          admission.resolve(outcome === "success" ? source.run : undefined);
        }
        if (outcome === "success") {
          await bounded(source.entered.promise);
          // The card and its trailing spacer are the only cold appends. Nothing
          // is dispatched through send/steer or added as runtime user context.
          expect(appended).toHaveBeenCalledTimes(2);
          send("\r");
          expect(api.continue).toHaveBeenCalledOnce();
          source.end.resolve();
        }
        await bounded(settled);
        expect(components().footer.render(100).join("")).not.toMatch(
          SPINNER_PATTERN
        );
        expect(components().editor.disableSubmit).toBe(false);
        expect(api.send).not.toHaveBeenCalled();
        expect(api.steer).not.toHaveBeenCalled();
        if (outcome !== "success") {
          expect(appended).not.toHaveBeenCalled();
        }
      } finally {
        admission.resolve(undefined);
        source.end.resolve();
        exit();
        await bounded(run);
      }
    }
  );

  it.each(["predecessor", "replacement"] as const)(
    "retains active turn ownership when %s finishes first",
    async (first) => {
      const predecessor = stream();
      const replacement = stream();
      const admitted = gate();
      const release = gate();
      const api = thread();
      api.send.mockResolvedValue(predecessor.run);
      api.steer.mockImplementation(async () => {
        admitted.resolve();
        await release.promise;
        return replacement.run;
      });
      const ready = idle();
      const run = createAgentTUI({ thread: api });
      try {
        await bounded(ready);
        send("go\r");
        await bounded(predecessor.entered.promise);
        send("steer\r");
        await bounded(admitted.promise);
        release.resolve();
        await bounded(replacement.entered.promise);
        const ended = gate();
        const original = TuiSessionMachine.prototype.endTurn;
        const spy = vi
          .spyOn(TuiSessionMachine.prototype, "endTurn")
          .mockImplementation(function (this: TuiSessionMachine, turn) {
            original.call(this, turn);
            ended.resolve();
          });
        (first === "predecessor" ? predecessor : replacement).end.resolve();
        await bounded(ended.promise);
        spy.mockRestore();
        send("\r");
        expect(api.continue).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        predecessor.end.resolve();
        replacement.end.resolve();
        exit();
        await bounded(run);
      }
    }
  );

  it("keeps the underlying prompt unconfirmed by the top prompt's repeat", async () => {
    let ui!: CodingAgentExtensionUi;
    const api = thread();
    const ready = idle();
    const run = createAgentTUI({
      thread: api,
      onExtensionUiReady: (create) => {
        ui = create();
      },
    });
    try {
      await bounded(ready);
      const lower = ui.input({ label: "LOWER" });
      const upper = ui.confirm("UPPER");
      terminal.send("\r");
      expect(await bounded(upper)).toBe(true);
      terminal.send("\x1b[13;1:2u");
      send("fresh");
      terminal.send("\x1b[13;1:3u");
      terminal.send("\x1b[13u");
      expect(await bounded(lower)).toBe("fresh");
      expect(api.continue).not.toHaveBeenCalled();
    } finally {
      exit();
      await bounded(run);
    }
  });

  it("routes parsed CRLF once and keeps LF as composer newline", async () => {
    const api = thread();
    const ready = idle();
    const run = createAgentTUI({ thread: api });
    const parser = new StdinBuffer();
    parser.on("data", terminal.send);
    try {
      await bounded(ready);
      const settled = idle();
      parser.process("\r\n");
      await bounded(settled);
      expect(api.continue).toHaveBeenCalledOnce();
      expect(components().editor.getText()).toBe("\n");
      const next = idle();
      parser.process("\r");
      await bounded(next);
      expect(api.continue).toHaveBeenCalledTimes(2);
    } finally {
      parser.destroy();
      exit();
      await bounded(run);
    }
  });

  it.each(["model", "session"] as const)(
    "does not carry Enter repeats after the %s selector settles",
    async (kind) => {
      const api = thread();
      const opened = gate();
      const ready = idle();
      const run = createAgentTUI({
        thread: api,
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
          listModelIds: async () => ["one"],
          currentModelId: () => {
            opened.resolve();
            return "one";
          },
          switchModel: () => undefined,
        },
        sessionSelector: {
          listSessions: async () => [
            {
              key: "one",
              cwd: process.cwd(),
              createdAt: "2026-09-09T00:00:00Z",
              updatedAt: "2026-09-09T00:00:00Z",
            },
          ],
          currentSessionKey: () => {
            opened.resolve();
            return "one";
          },
          switchSession: async () => undefined,
          loadCurrentHistory: async () => [],
        },
      });
      try {
        await bounded(ready);
        send("/picker\r");
        await bounded(opened.promise);
        const settled = idle();
        terminal.send("\r");
        await bounded(settled);
        const submitted = vi.spyOn(TuiSessionMachine.prototype, "submitInput");
        terminal.send("\x1b[13;1:2u");
        expect(submitted).not.toHaveBeenCalled();
        const next = idle();
        terminal.send("\x1b[13u");
        await bounded(next);
        expect(api.continue).toHaveBeenCalledOnce();
      } finally {
        exit();
        await bounded(run);
      }
    }
  );

  it.each(["success", "undefined", "reject", "unresolved"] as const)(
    "exits before %s admission settles, without late subscription",
    async (outcome) => {
      const admission = gate<AgentTurn | undefined>();
      const entered = gate();
      const api = thread();
      api.continue.mockImplementation(() => {
        entered.resolve();
        return admission.promise;
      });
      const ready = idle();
      const run = createAgentTUI({ thread: api });
      const events = vi.fn(() => emptyRun().events());
      try {
        await bounded(ready);
        send("\r");
        await bounded(entered.promise);
        expect
          .soft(components().footer.render(100).join(""))
          .toMatch(SPINNER_PATTERN);
        exit();
        await bounded(run);
        const transcript = terminal.screen?.children.find(
          (component) => component instanceof TranscriptOwner
        );
        if (!(transcript instanceof TranscriptOwner)) {
          throw new Error("Missing transcript");
        }
        const appended = vi.spyOn(transcript, "addChild");
        const settled = admission.promise.then(
          () => undefined,
          () => undefined
        );
        if (outcome === "success") {
          admission.resolve({ events });
        }
        if (outcome === "undefined") {
          admission.resolve(undefined);
        }
        if (outcome === "reject") {
          admission.reject(new Error("late admission"));
        }
        if (outcome !== "unresolved") {
          await settled;
        }
        expect(events).not.toHaveBeenCalled();
        expect(appended).not.toHaveBeenCalled();
        expect(api.send).not.toHaveBeenCalled();
      } finally {
        admission.resolve(undefined);
        exit();
        await bounded(run);
      }
    }
  );

  it("does not admit an input resolved in the same tick as exit", async () => {
    const api = thread();
    const ready = idle();
    const run = createAgentTUI({ thread: api });
    await bounded(ready);
    send("\r");
    exit();
    await bounded(run);
    expect(api.continue).not.toHaveBeenCalled();
  });

  it.each(
    ["accept", "reject", "throw", "admission", "command"].flatMap((boundary) =>
      ["predecessor", "operation"].map((first) => ({ boundary, first }))
    )
  )(
    "retains ownership when $first finishes first during steering $boundary",
    async ({ boundary, first }) => {
      const source = stream();
      const entered = gate();
      const release = gate();
      const api = thread();
      api.send.mockResolvedValue(source.run);
      api.steer.mockResolvedValue(source.run);
      if (boundary === "admission") {
        api.steer.mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return source.run;
        });
      }
      const ready = idle();
      const config: AgentTUIConfig = {
        thread: api,
        commands: [
          {
            name: "pending",
            description: "fixture",
            allowDuringActiveTurn: true,
            execute: async () => {
              entered.resolve();
              await release.promise;
              return { success: true };
            },
          },
        ],
        preprocessUserInput: async (text) => {
          if (text !== "steer" || boundary === "admission") {
            return;
          }
          entered.resolve();
          await release.promise;
          if (boundary === "reject") {
            return { success: false, error: "fixture rejection" };
          }
          if (boundary === "throw") {
            throw new Error("fixture failure");
          }
        },
      };
      const run = createAgentTUI(config);
      try {
        await bounded(ready);
        send("hello\r");
        await bounded(source.entered.promise);
        send(boundary === "command" ? "/pending\r" : "steer\r");
        await bounded(entered.promise);
        if (first === "predecessor") {
          const awaiting = idle();
          source.end.resolve();
          await bounded(awaiting);
          expect(components().editor.disableSubmit).toBe(true);
          send("\r");
          expect(api.continue).not.toHaveBeenCalled();
          const unlocked = whenUnlocked();
          release.resolve();
          await bounded(unlocked);
        } else {
          const unlocked = whenUnlocked();
          release.resolve();
          await bounded(unlocked);
          send("\r");
          expect(api.continue).not.toHaveBeenCalled();
          const awaiting = idle();
          source.end.resolve();
          await bounded(awaiting);
        }
        const settled = idle();
        send("\r");
        await bounded(settled);
        expect(api.continue).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        source.end.resolve();
        exit();
        await bounded(run);
      }
    }
  );

  it.each(["success", "failure"] as const)(
    "blocks %s foreground finalization but not an unrelated extension status",
    async (outcome) => {
      const release = gate();
      const entered = gate();
      const api = thread();
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      let ui!: CodingAgentExtensionUi;
      const ready = idle();
      const run = createAgentTUI({
        thread: api,
        onExtensionUiReady: (create) => {
          ui = create();
        },
        onTurnComplete: () => {
          entered.resolve();
          return release.promise;
        },
      });
      try {
        await bounded(ready);
        const awaiting = idle();
        send("hello\r");
        await bounded(entered.promise);
        await bounded(awaiting);
        const submitted = vi.spyOn(TuiSessionMachine.prototype, "submitInput");
        send("\r");
        expect(submitted).not.toHaveBeenCalled();
        expect(api.continue).not.toHaveBeenCalled();
        const unlocked = whenUnlocked();
        if (outcome === "failure") {
          release.reject(new Error("finalization fixture"));
        } else {
          release.resolve();
        }
        await bounded(unlocked);
        const clear = ui.status("BACKGROUND");
        const settled = idle();
        send("\r");
        await bounded(settled);
        clear();
        expect(api.continue).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        exit();
        await bounded(run);
        expect(logged).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
      }
    }
  );

  it.each(["input", "confirm", "select"] as const)(
    "does not carry Enter repeats from extension %s to the composer",
    async (kind) => {
      const api = thread();
      let ui!: CodingAgentExtensionUi;
      const ready = idle();
      const run = createAgentTUI({
        thread: api,
        onExtensionUiReady: (create) => {
          ui = create();
        },
      });
      try {
        await bounded(ready);
        const prompts = {
          input: () => ui.input({ label: "VALUE" }),
          confirm: () => ui.confirm("VALUE"),
          select: () =>
            ui.select({
              label: "VALUE",
              options: [{ label: "A", value: "a" }],
            }),
        };
        const answer = prompts[kind]();
        terminal.send("\x1b[13;1u");
        await bounded<string | boolean | undefined>(answer);
        const submitted = vi.spyOn(TuiSessionMachine.prototype, "submitInput");
        terminal.send("\x1b[13;1:2u");
        terminal.send("\x1b[13;1:3u");
        expect(submitted).not.toHaveBeenCalled();
        expect(api.continue).not.toHaveBeenCalled();
        const settled = idle();
        terminal.send("\x1b[13;1u");
        await bounded(settled);
        expect(api.continue).toHaveBeenCalledOnce();
        if (kind === "input") {
          expect(await answer).toBe("");
        }
      } finally {
        exit();
        await bounded(run);
      }
    }
  );
});
