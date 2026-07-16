import { describe, expect, it } from "vitest";
import { MemoryAttachmentStore } from "../../platform/memory";
import {
  decodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "../input/attachments";
import type { AgentPlugin } from "../plugins/pipeline";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadEventDispatcher } from "./events";

function createDispatcher(
  plugins: readonly AgentPlugin[],
  attachmentStore?: MemoryAttachmentStore
): ThreadEventDispatcher {
  return new ThreadEventDispatcher({
    attachmentStore,
    history: () => [],
    plugins,
    signal: () => undefined,
    threadKey: "test-thread",
  });
}

describe("ThreadEventDispatcher.emitRunEvent", () => {
  it("returns transformed user-input and emits the transformed event", async () => {
    const transformPlugin: AgentPlugin = {
      on: ({ event }) => {
        if (
          event.type !== "user-input" ||
          !("text" in event) ||
          typeof event.text !== "string"
        ) {
          return;
        }
        return {
          action: "transform",
          event: { ...event, text: `TAG:${event.text}` },
        };
      },
    };
    const dispatcher = createDispatcher([transformPlugin]);
    const run = new BufferedAgentTurn();

    const emitted = await dispatcher.emitRunEvent(run, {
      type: "user-input",
      text: "hello",
    });

    expect(emitted).toEqual({ type: "user-input", text: "TAG:hello" });
    const iterator = run.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      type: "user-input",
      text: "TAG:hello",
    });
    await iterator.return?.();
  });

  it("stages plugin-transformed file bytes before emitting user-input", async () => {
    const attachmentStore = new MemoryAttachmentStore();
    const transformPlugin: AgentPlugin = {
      on: ({ event }) => {
        if (event.type !== "user-input") {
          return;
        }
        return {
          action: "transform",
          event: {
            content: [
              {
                data: new Uint8Array([1, 2, 3]),
                mediaType: "application/octet-stream",
                type: "file",
              },
            ],
            type: "user-input",
          },
        };
      },
    };
    const dispatcher = createDispatcher([transformPlugin], attachmentStore);
    const run = new BufferedAgentTurn();

    const emitted = await dispatcher.emitRunEvent(run, {
      type: "user-input",
      text: "hello",
    });

    if (emitted === "handled" || !("content" in emitted)) {
      throw new Error("expected emitted multipart user-input");
    }
    const part = emitted.content[0];
    expect(part?.type).toBe("file");
    if (part?.type !== "file") {
      throw new Error("expected emitted file part");
    }
    const ref = part.data;
    if (!isRuntimeAttachmentData(ref)) {
      throw new Error("expected runtime attachment data");
    }
    const blob = await attachmentStore.get(decodeRuntimeAttachmentData(ref));
    expect(blob?.bytes).toEqual(new Uint8Array([1, 2, 3]));

    const iterator = run.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(emitted);
    await iterator.return?.();
  });

  it("stages plugin-transformed file bytes before returning runtime-input", async () => {
    const attachmentStore = new MemoryAttachmentStore();
    const transformPlugin: AgentPlugin = {
      on: ({ event }) => {
        if (event.type !== "runtime-input") {
          return;
        }
        return {
          action: "transform",
          event: {
            input: {
              content: [
                {
                  data: new Uint8Array([4, 5, 6]),
                  mediaType: "application/octet-stream",
                  type: "file",
                },
              ],
              type: "user-input",
            },
            placement: event.placement,
            type: "runtime-input",
          },
        };
      },
    };
    const dispatcher = createDispatcher([transformPlugin], attachmentStore);

    const emitted = await dispatcher.interceptEvent({
      input: { text: "hint", type: "user-input" },
      placement: "step-start",
      type: "runtime-input",
    });

    if (
      emitted === "handled" ||
      emitted.type !== "runtime-input" ||
      !("content" in emitted.input)
    ) {
      throw new Error("expected emitted multipart runtime-input");
    }
    const part = emitted.input.content[0];
    expect(part?.type).toBe("file");
    if (part?.type !== "file") {
      throw new Error("expected emitted runtime-input file part");
    }
    const ref = part.data;
    if (!isRuntimeAttachmentData(ref)) {
      throw new Error("expected runtime attachment data");
    }
    const blob = await attachmentStore.get(decodeRuntimeAttachmentData(ref));
    expect(blob?.bytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("returns handled without emitting user-input to the run", async () => {
    const handledPlugin: AgentPlugin = {
      on: () => ({ action: "handled" }),
    };
    const dispatcher = createDispatcher([handledPlugin]);
    const run = new BufferedAgentTurn();

    const emitted = await dispatcher.emitRunEvent(run, {
      type: "user-input",
      text: "hello",
    });

    expect(emitted).toBe("handled");
    run.close();
    const iterator = run.events()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});

describe("ThreadEventDispatcher.emitObserverEvent", () => {
  it("emits observer events to the active run and plugins", async () => {
    const pluginEventTypes: string[] = [];
    const dispatcher = createDispatcher([
      {
        on: ({ event }) => {
          pluginEventTypes.push(event.type);
        },
      },
    ]);
    const run = new BufferedAgentTurn();

    await dispatcher.emitObserverEvent(run, {
      text: "observer reasoning",
      type: "assistant-reasoning",
    });

    const iterator = run.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      text: "observer reasoning",
      type: "assistant-reasoning",
    });
    await iterator.return?.();
    expect(pluginEventTypes).toEqual(["assistant-reasoning"]);
  });

  it("buffers observer events during capture", async () => {
    const dispatcher = createDispatcher([]);
    const run = new BufferedAgentTurn();

    const captured = await dispatcher.captureObserverEvents(run, async () => {
      await dispatcher.emitObserverEvent(run, {
        text: "captured reasoning",
        type: "assistant-reasoning",
      });
      return "ok";
    });

    expect(captured.value).toBe("ok");
    expect(captured.events).toEqual([
      { text: "captured reasoning", type: "assistant-reasoning" },
    ]);
    captured.release();
  });
});

describe("ThreadEventDispatcher.emitRunBoundaryEvent", () => {
  it("ignores transform returns on boundary events", async () => {
    const transformPlugin: AgentPlugin = {
      on: () => ({
        action: "transform",
        event: { type: "user-input", text: "ignored" },
      }),
    };
    const dispatcher = createDispatcher([transformPlugin]);
    const run = new BufferedAgentTurn();

    const iterator = run.events()[Symbol.asyncIterator]();
    const boundary = dispatcher.emitRunBoundaryEvent(run, {
      type: "turn-start",
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn-start" },
    });

    const waiting = iterator.next();
    await boundary;
    run.close();
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
  });
});
