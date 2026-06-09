import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import type { RuntimeLlm } from "../llm";
import {
  assistantMessage,
  createDeferred,
  eventTypes,
  notifyRuntimeInput,
  userText,
} from "../test-fixtures";
import type { AgentEvent } from "./events";
import { userTextToModelMessage } from "./mapping";
import type { AgentRun } from "./run";
import { AgentSession } from "./session";
import { MemorySessionStore } from "./store/memory";

describe("AgentSession.notify", () => {
  it("keeps direct user sends observable through the returned run", async () => {
    const session = createSession("send-run-observable", () =>
      Promise.resolve([assistantMessage("SENT")])
    );

    const events = await collectAgentRun(await session.send("hello"));

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
    const session = createSession("notify-runtime-input", ({ history }) => {
      seenHistory.push([...history]);
      return Promise.resolve([assistantMessage("NOTIFIED")]);
    });

    const events = await collectAgentRun(await session.notify(notification));

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
    const session = createSession("notify-run-stream", () =>
      Promise.resolve([assistantMessage("NOTIFIED")])
    );

    const directRun = await session.notify("job done");
    const events = await collectAgentRun(directRun);

    expect(eventTypes(events)).toContain("runtime-input");
  });

  it("merges a notification before the next queued user input in model context", async () => {
    const firstCanFinish = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const session = createSession(
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

    const firstIterator = (await session.send("first"))
      .events()
      [Symbol.asyncIterator]();
    await readUntil(firstIterator, "step-start");

    const secondRun = await session.send("second");
    const notifiedRun = await session.notify("background done");
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

  it("does not expose notify on public Agent session handles", () => {
    const session = new Agent({
      model: () => Promise.resolve([assistantMessage("DONE")]),
    }).session("public-notify-hidden");

    expect(
      getProperty(session, "notify"),
      "public session.notify is not exposed"
    ).toBeUndefined();
  });
});

function createSession(key: string, llm: RuntimeLlm): AgentSession {
  return new AgentSession(llm, { key, store: new MemorySessionStore() });
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
): Promise<void> {
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return;
    }
  }
}
