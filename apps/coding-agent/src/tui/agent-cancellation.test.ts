import {
  Container,
  type Terminal,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { createAgentTUI, FooterStatusBar } from "./agent";
import { BusyStatus } from "./busy-status";
import { ComposerEditor } from "./composer-editor";
import { TuiSessionMachine } from "./session-state";
import { ColdSnapshot, TranscriptOwner } from "./transcript-owner";

const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

// Local public-contract fixture: producers await the consumer's next pull,
// so assertions observe a processed boundary rather than merely queued input.
const eventChannel = () => {
  const queue: {
    event: AgentEvent;
    consumed: ReturnType<typeof gate<void>>;
  }[] = [];
  let available = gate();
  let closed = false;
  return {
    async *events(): AsyncIterable<AgentEvent> {
      while (!closed || queue.length > 0) {
        const next = queue.shift();
        if (next) {
          try {
            yield next.event;
          } finally {
            next.consumed.resolve();
          }
        } else {
          await available.promise;
          available = gate();
        }
      }
    },
    emitBoundary(event: AgentEvent): Promise<void> {
      const consumed = gate();
      queue.push({ event, consumed });
      available.resolve();
      return consumed.promise;
    },
    close() {
      closed = true;
      available.resolve();
    },
  };
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
const surfaces = () => {
  const transcript = terminal.screen?.children.find(
    (component) => component instanceof TranscriptOwner
  );
  const composer = terminal.screen?.children.at(-1);
  if (
    !(transcript instanceof TranscriptOwner && composer instanceof Container)
  ) {
    throw new Error("Missing TUI surface");
  }
  const editor = composer.children[0];
  const footer = composer.children[1];
  if (
    !(editor instanceof ComposerEditor && footer instanceof FooterStatusBar)
  ) {
    throw new Error("Missing composer");
  }
  return { transcript, editor, footer };
};
const blocks = (owner: TranscriptOwner) =>
  owner.children.filter((child) =>
    child.render(100).some((line) => line.trim().length > 0)
  );

afterEach(() => vi.restoreAllMocks());

describe.sequential("TUI cancellation terminal ownership", () => {
  it.each([
    { continuation: true, local: false, error: false, abort: true },
    { continuation: false, local: false, error: false, abort: true },
    { continuation: true, local: true, error: false, abort: true },
    { continuation: false, local: true, error: false, abort: true },
    { continuation: true, local: false, error: true, abort: true },
    { continuation: false, local: false, error: true, abort: true },
    { continuation: true, local: true, error: true, abort: true },
    { continuation: false, local: true, error: true, abort: true },
    { continuation: true, local: false, error: true, abort: false },
    { continuation: false, local: false, error: true, abort: false },
    { continuation: true, local: true, error: true, abort: false },
    { continuation: false, local: true, error: true, abort: false },
  ])(
    "settles $continuation continuation / $local local / $error error / $abort abort",
    async ({ continuation, local, error, abort }) => {
      const channel = eventChannel();
      const subscribed = gate();
      const run: AgentTurn = {
        events() {
          const source = channel.events();
          subscribed.resolve();
          return source;
        },
      };
      const api = {
        send: vi.fn(async () => run),
        steer: vi.fn(async () => run),
        continue: vi.fn(async () => run),
        interrupt: vi.fn(),
      };
      const completed = vi.fn();
      const ready = idle();
      const app = createAgentTUI({ thread: api, onTurnComplete: completed });
      try {
        await bounded(ready);
        send(continuation ? "\r" : "ORIGINAL\r");
        await bounded(subscribed.promise);
        const { transcript, footer, editor } = surfaces();
        const accepted = [...transcript.children];
        const snapshots = accepted.map((child) => child.render(100));
        expect(blocks(transcript)).toHaveLength(1);
        expect(accepted.every((child) => child instanceof ColdSnapshot)).toBe(
          true
        );
        expect(footer.getForegroundMessage()).not.toBeNull();
        const finalization = vi.spyOn(BusyStatus.prototype, "run");
        const settled = idle();
        if (local) {
          send("\x1b");
          expect(api.interrupt).toHaveBeenCalledTimes(1);
        }
        // Public event contract: abort can precede a storage/settlement error.
        if (abort) {
          await bounded(channel.emitBoundary({ type: "turn-abort" }));
        }
        expect(blocks(transcript)).toHaveLength(1);
        if (error) {
          await bounded(
            channel.emitBoundary({
              type: "turn-error",
              message: "CANCEL_STORAGE_FAILURE",
            })
          );
        }
        channel.close();
        await bounded(settled);
        expect(blocks(transcript)).toHaveLength(2);
        expect(completed).not.toHaveBeenCalled();
        expect(finalization).not.toHaveBeenCalled();
        expect(footer.getForegroundMessage()).toBeNull();
        expect(editor.disableSubmit).toBe(false);
        expect(editor.getText()).toBe("");
        expect(api.send).toHaveBeenCalledTimes(continuation ? 0 : 1);
        expect(api.steer).not.toHaveBeenCalled();
        expect(api.continue).toHaveBeenCalledTimes(continuation ? 1 : 0);
        expect(api.interrupt).toHaveBeenCalledTimes(local ? 1 : 0);
        expect(transcript.children.slice(0, accepted.length)).toEqual(accepted);
        expect(accepted.map((child) => child.render(100))).toEqual(snapshots);
        expect(
          transcript.children.every((child) => child instanceof ColdSnapshot)
        ).toBe(true);
        if (error) {
          expect(transcript.render(100).join("\n")).toContain(
            "CANCEL_STORAGE_FAILURE"
          );
        }
      } finally {
        channel.close();
        exit();
        await bounded(app);
      }
    }
  );
});
