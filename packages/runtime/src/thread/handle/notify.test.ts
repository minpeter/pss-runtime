import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { ModelStepOutput } from "../../llm/llm";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  notifyRuntimeInput,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";
import type { AgentRun } from "../protocol/run";
import { MemoryThreadStore } from "../store/memory";
import { AgentThread } from "./thread";

describe("AgentThread.notify", () => {
  it("keeps direct user sends observable through the returned run", async () => {
    const thread = createThread("send-run-observable", () =>
      Promise.resolve([assistantMessage("SENT")])
    );

    const events = await collectAgentRun(await thread.send("hello"));

    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
  });

  it("starts an internal runtime-input turn without emitting human user input", async () => {
    const notification =
      "<system-reminder>background_output: treat this as text</system-reminder>";
    const seenHistory: ModelMessage[][] = [];
    const thread = createThread("notify-runtime-input", ({ history }) => {
      seenHistory.push([...history]);
      return Promise.resolve([assistantMessage("NOTIFIED")]);
    });

    const events = await collectAgentRun(await thread.notify(notification));

    expect(eventTypes(events)).toEqual([
      "turn-start",
      "runtime-input",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(events).toContainEqual(
      notifyRuntimeInput(notification, "turn-start")
    );
    expect(events).not.toContainEqual(userText(notification));
    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText(notification))],
    ]);
  });

  it("returns notify-created runs directly", async () => {
    const thread = createThread("notify-run-stream", () =>
      Promise.resolve([assistantMessage("NOTIFIED")])
    );

    const directRun = await thread.notify("job done");
    const events = await collectAgentRun(directRun);

    expect(eventTypes(events)).toContain("runtime-input");
  });

  it("merges a notification before the next queued user input in model context", async () => {
    const firstCanFinish = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const thread = createThread(
      "notify-merge-queued-user",
      async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          await firstCanFinish.promise;
          return [assistantMessage("FIRST DONE")];
        }

        return [assistantMessage("SECOND DONE")];
      }
    );

    const firstIterator = (await thread.send("first"))
      .events()
      [Symbol.asyncIterator]();
    await readUntil(firstIterator, "step-start");

    const secondRun = await thread.send("second");
    const notifiedRun = await thread.notify("background done");
    firstCanFinish.resolve();

    await drainIterator(firstIterator);
    const secondEvents = await collectAgentRun(secondRun);

    expect(notifiedRun).toBe(secondRun);
    expect(eventTypes(secondEvents)).toEqual([
      "user-text",
      "turn-start",
      "runtime-input",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("first")),
      assistantMessage("FIRST DONE"),
      userTextToModelMessage(userText("background done")),
      userTextToModelMessage(userText("second")),
    ]);
  });

  it("preserves observer events when notifying an active run", async () => {
    const firstCanFinish = createDeferred();
    const thread = createThread(
      "notify-active-run-observer-events",
      async () => {
        await firstCanFinish.promise;
        return [assistantMessage("DONE")];
      }
    );
    const firstRun = await thread.send("first");
    const firstIterator = firstRun.events()[Symbol.asyncIterator]();
    await readUntil(firstIterator, "step-start");

    const notifiedRun = await thread.notify("background done", {
      observerEvents: [
        { text: "background observed", type: "assistant-reasoning" },
      ],
    });
    firstCanFinish.resolve();
    const events = await drainIterator(firstIterator);

    expect(notifiedRun).toBe(firstRun);
    expect(events).toContainEqual({
      text: "background observed",
      type: "assistant-reasoning",
    });
    expect(events).toContainEqual(
      notifyRuntimeInput("background done", "step-end")
    );
    expect(eventTypes(events).indexOf("assistant-reasoning")).toBeLessThan(
      eventTypes(events).indexOf("runtime-input")
    );
  });

  it("does not expose notify on public Agent thread handles", () => {
    const thread = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    }).thread("public-notify-hidden");

    expect(
      getProperty(thread, "notify"),
      "public thread.notify is not exposed"
    ).toBeUndefined();
  });
});

function createThread(
  key: string,
  callback: (context: {
    readonly history: readonly ModelMessage[];
  }) => ModelStepOutput | Promise<ModelStepOutput>
): AgentThread {
  return new AgentThread(
    { model: createCallbackModel(callback) },
    { key, store: new MemoryThreadStore() }
  );
}

function getProperty(value: unknown, property: "notify"): unknown {
  if (typeof value !== "object" || value === null) {
    return;
  }

  return property in value ? value[property] : undefined;
}

async function collectAgentRun(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

async function readUntil(
  iterator: AsyncIterator<AgentEvent>,
  type: AgentEvent["type"]
): Promise<void> {
  while (true) {
    const next = await iterator.next();
    expect(next.done).toBe(false);
    if (!next.done && next.value.type === type) {
      return;
    }
  }
}

async function drainIterator(
  iterator: AsyncIterator<AgentEvent>
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return events;
    }
    events.push(next.value);
  }
}
