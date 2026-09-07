import {
  type Component,
  Container,
  stripTerminalSequences,
  type Terminal,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import {
  type AgentEvent,
  type AgentTurn,
  type ContextUsageSnapshot,
  createAgent,
} from "@minpeter/pss-runtime";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  send: (_data: string): void => undefined,
  surface: undefined as TuiMainScreen | undefined,
}));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  const noop = () => undefined;
  class TestTerminal implements Terminal {
    columns = 120;
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
      harness.send = onInput;
    }
  }
  class TestScreen extends actual.TuiMainScreen {
    override start() {
      harness.surface = this;
      super.start();
    }
  }
  return {
    ...actual,
    ProcessTerminal: TestTerminal,
    TuiMainScreen: TestScreen,
  };
});

import { createAgentTUI, FooterStatusBar } from "./agent";
import { TuiSessionMachine } from "./session-state";
import { contextUsageFooter } from "./usage-footer";

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
          () => reject(new Error("Missing stream event")),
          3000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const findFooter = (component: Component): FooterStatusBar | undefined => {
  if (component instanceof FooterStatusBar) {
    return component;
  }
  if (component instanceof Container) {
    for (const child of component.children) {
      const result = findFooter(child);
      if (result) {
        return result;
      }
    }
  }
  return;
};
const idleGate = () => {
  const idle = gate();
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      idle.resolve();
    });
  return idle.promise;
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.sequential("streamed tool argument usage in the mounted footer", () => {
  it.each(["reported", "missing", "aborted"] as const)(
    "counts generated arguments before execution with %s final usage",
    async (completion) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const controllerReady = gate<ReadableStreamDefaultController>();
      const secondProvider = gate();
      const releaseSecond = gate();
      const toolStarted = vi.fn();
      const releaseTools = gate();
      let calls = 0;
      const model = new MockLanguageModelV4({
        doStream: async () => {
          if (calls++ > 0) {
            secondProvider.resolve();
            await releaseSecond.promise;
          }
          return {
            stream: new ReadableStream({
              start(controller) {
                if (calls === 1) {
                  controllerReady.resolve(controller);
                } else {
                  controller.enqueue({
                    type: "finish",
                    finishReason: { raw: "stop", unified: "stop" },
                    usage: {
                      inputTokens: {
                        total: 20,
                        noCache: 20,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                      },
                      outputTokens: { total: 1, text: 1, reasoning: undefined },
                    },
                  });
                  controller.close();
                }
              },
            }),
          };
        },
      });
      const agent = await createAgent({
        model,
        ...(completion === "missing"
          ? { contextTokens: { calibration: false } }
          : {}),
        tools: {
          write_file: tool({
            inputSchema: jsonSchema<{ content: string; path: string }>({
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            }),
            execute: async (args) => {
              toolStarted(args);
              await releaseTools.promise;
              return "TOOL_STDOUT_".repeat(5000);
            },
          }),
        },
      });
      const thread = agent.thread("tool-tokens");
      const events: AgentEvent[] = [];
      const snapshots: ContextUsageSnapshot[] = [];
      let pendingEvent:
        | {
            predicate: (event: AgentEvent) => boolean;
            done: ReturnType<typeof gate<void>>;
          }
        | undefined;
      const nextEvent = (predicate: (event: AgentEvent) => boolean) => {
        const done = gate();
        pendingEvent = { predicate, done };
        return done.promise;
      };
      const observe = (turn: AgentTurn): AgentTurn => ({
        ...turn,
        events: () =>
          (async function* () {
            for await (const event of turn.events()) {
              events.push(event);
              yield event;
              if (pendingEvent?.predicate(event)) {
                pendingEvent.done.resolve();
                pendingEvent = undefined;
              }
            }
          })(),
      });
      const footer: { text?: string } = {};
      const idle = idleGate();
      const app = createAgentTUI({
        footer,
        thread: {
          interrupt: () => thread.interrupt(),
          send: async (text) => observe(await thread.send(text)),
          steer: (text) => thread.steer(text),
        },
        onContextUsage: (snapshot) => {
          snapshots.push(snapshot);
          footer.text = contextUsageFooter(snapshot);
        },
      });
      await idle;
      const settled = idleGate();
      let generated = "";
      try {
        const initial = nextEvent((event) => event.type === "context-usage");
        for (const character of "go\r") {
          harness.send(character);
        }
        const controller = await bounded(controllerReady.promise);
        await bounded(initial);
        const assertLive = () => {
          const snapshot = snapshots.at(-1);
          expect(snapshot?.currentRequest.output.tokens).toBe(
            Math.ceil(generated.length / 4)
          );
          expect(snapshot?.currentRequest.output.basis).toBe("heuristic");
          const mounted = harness.surface && findFooter(harness.surface);
          expect(mounted).toBeDefined();
          expect(
            stripTerminalSequences(mounted?.render(120).join("") ?? "")
              .trimEnd()
              .endsWith(footer.text ?? "")
          ).toBe(true);
          expect(toolStarted).not.toHaveBeenCalled();
        };
        assertLive();
        const delta = async (part: {
          type: string;
          id: string;
          delta: string;
        }) => {
          const consumed = nextEvent((event) => event.type === "context-usage");
          generated += part.delta;
          controller.enqueue(part);
          await bounded(consumed);
          assertLive();
        };
        if (completion === "missing") {
          for (const kind of ["text", "reasoning"]) {
            controller.enqueue({ type: `${kind}-start`, id: kind });
            await delta({
              type: `${kind}-delta`,
              id: kind,
              delta: "prefix 世界",
            });
            controller.enqueue({ type: `${kind}-end`, id: kind });
          }
        }
        const argumentsById = new Map<string, string>();
        for (const id of completion === "missing" ? ["one", "two"] : ["one"]) {
          const args = JSON.stringify({
            path: `${id}.txt`,
            content: `\\"世界😀${"content".repeat(5000)}`,
          });
          argumentsById.set(id, args);
          controller.enqueue({
            type: "tool-input-start",
            id,
            toolName: "write_file",
          });
          for (const chunk of [
            args.slice(0, 30),
            args.slice(30, 256),
            args.slice(256, 8192),
            args.slice(8192),
          ]) {
            await delta({ type: "tool-input-delta", id, delta: chunk });
          }
          controller.enqueue({ type: "tool-input-end", id });
        }
        if (completion === "aborted") {
          thread.interrupt();
          controller.close();
          await settled;
          expect(toolStarted).not.toHaveBeenCalled();
          expect(events.some((event) => event.type === "turn-abort")).toBe(
            true
          );
          expect(snapshots.at(-1)?.currentRequest.output.tokens).toBe(0);
          expect(events.some((event) => event.type === "model-usage")).toBe(
            false
          );
          return;
        }
        for (const [id, args] of argumentsById) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: id,
            toolName: "write_file",
            input: args,
          });
        }
        const result = nextEvent((event) => event.type === "tool-result");
        controller.enqueue({
          type: "finish",
          finishReason: { raw: "tool_calls", unified: "tool-calls" },
          usage:
            completion === "reported"
              ? {
                  inputTokens: { total: 41, cacheRead: 11, noCache: 30 },
                  outputTokens: { total: 777 },
                }
              : { inputTokens: {}, outputTokens: {} },
        });
        controller.close();
        releaseTools.resolve();
        await result;
        const final = snapshots.at(-1)?.currentRequest.output;
        expect(final?.tokens).toBe(
          completion === "reported" ? 777 : Math.ceil(generated.length / 4)
        );
        expect(final?.basis).toBe(
          completion === "reported" ? "reported" : "heuristic"
        );
        const usage = events.find((event) => event.type === "model-usage");
        if (completion === "reported") {
          expect(usage).toMatchObject({
            inputTokens: 41,
            outputTokens: 777,
            cacheReadTokens: 11,
          });
        }
        await bounded(secondProvider.promise);
        releaseSecond.resolve();
        await settled;
      } finally {
        releaseTools.resolve();
        releaseSecond.resolve();
        thread.interrupt();
        await settled;
        process.emit("SIGINT", "SIGINT");
        process.emit("SIGINT", "SIGINT");
        await app;
        await agent.dispose();
      }
    }
  );
});
