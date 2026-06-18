import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect, SpyStore } from "./test-support";

const timeoutMarker = Symbol("timeout");

describe("Agent session terminal state", () => {
  it("rejects runtime input after dispose and settles queued runs", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const session = new Agent({
      model: createCallbackModel(async () => {
        llmStarted.resolve();
        await llmGate.promise;
        return [assistantMessage("DONE")];
      }),
    }).session("kill-terminal");
    const firstRun = await session.send("first");
    const secondRun = await session.send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);

    await llmStarted.promise;
    session.dispose();
    llmGate.resolve();

    expect(eventTypes(await firstEvents)).toContain("turn-error");
    expect(eventTypes(await secondEvents)).toEqual(["user-text", "turn-error"]);
    await expect(session.steer("late")).rejects.toThrow("Session killed");
  });

  it("closes the active run when a disposed session has a pending model call", async () => {
    const llmStarted = createDeferred();
    const agent = new Agent({
      model: createCallbackModel(() => {
        llmStarted.resolve();
        return new Promise<never>(() => undefined);
      }),
    });
    const session = agent.session("kill-pending-model");
    const collecting = collect(await session.send("hello"));
    await llmStarted.promise;

    session.dispose();

    const events = await withShortTimeout(collecting);
    if (events === timeoutMarker) {
      throw new Error("session.dispose() did not close the active run");
    }
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
  });

  it("closes the active run when a disposed session has a pending terminal event plugin", async () => {
    const terminalPluginStarted = createDeferred();
    const agent = new Agent({
      plugins: [
        {
          on: ({ event }) => {
            if (event.type === "turn-end") {
              terminalPluginStarted.resolve();
              return new Promise<never>(() => undefined);
            }
          },
        },
      ],
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const session = agent.session("kill-pending-terminal-event");
    const collecting = collect(await session.send("hello"));
    await terminalPluginStarted.promise;

    session.dispose();

    const events = await withShortTimeout(collecting);
    if (events === timeoutMarker) {
      throw new Error("session.dispose() did not close the terminal event run");
    }
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-error",
    ]);
  });

  it("does not persist an active turn after session delete", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(async ({ history }) => {
        seenHistory.push([...history]);
        if (seenHistory.length === 1) {
          llmStarted.resolve();
          await llmGate.promise;
        }
        return [assistantMessage("DONE")];
      }),
    });
    const session = agent.session("delete-active");
    const deletedRun = collect(await session.send("first"));

    await llmStarted.promise;
    await session.delete();
    llmGate.resolve();
    await deletedRun;
    await collect(await agent.session("delete-active").send("fresh"));

    expect(seenHistory.at(-1)).toEqual([
      userTextToModelMessage(userText("fresh")),
    ]);
  });

  it("closes the active run while session delete is pending", async () => {
    const llmStarted = createDeferred();
    const store = new BlockingDeleteStore();
    const agent = new Agent({
      host: { kind: "session", sessionStore: store },
      model: createCallbackModel(() => {
        llmStarted.resolve();
        return new Promise<never>(() => undefined);
      }),
    });
    const session = agent.session("delete-pending-active");
    const collecting = collect(await session.send("hello"));

    await llmStarted.promise;
    const deletion = session.delete();
    await store.deleteStarted.promise;
    const events = await withShortTimeout(collecting);
    store.allowDelete.resolve();
    await deletion;

    if (events === timeoutMarker) {
      throw new Error("session.delete() did not close the active run");
    }
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
  });

  it("rejects new input while session delete is pending", async () => {
    const store = new BlockingDeleteStore();
    const session = new Agent({
      host: { kind: "session", sessionStore: store },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    }).session("delete-pending");

    await collect(await session.send("before"));
    const deletion = session.delete();
    await store.deleteStarted.promise;
    await expect(session.send("during")).rejects.toThrow("Session killed");
    await expect(session.steer("during")).rejects.toThrow("Session killed");
    store.allowDelete.resolve();
    await deletion;

    await expect(session.send("after")).rejects.toThrow("Session killed");
  });
});

function withShortTimeout<T>(
  promise: Promise<T>
): Promise<T | typeof timeoutMarker> {
  return Promise.race([
    promise,
    new Promise<typeof timeoutMarker>((resolve) => {
      setTimeout(() => resolve(timeoutMarker), 100);
    }),
  ]);
}

class BlockingDeleteStore extends SpyStore {
  readonly allowDelete = createDeferred();
  readonly deleteStarted = createDeferred();

  override async delete(key: string): Promise<void> {
    this.deleteStarted.resolve();
    await this.allowDelete.promise;
    await super.delete(key);
  }
}
