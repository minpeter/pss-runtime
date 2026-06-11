import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import type { AgentPlugin } from "../plugins";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  sentUserText,
  userText,
} from "../test-fixtures";
import { userTextToModelMessage } from "./mapping";
import { AgentSession } from "./session";
import { collect } from "./session.test-support";
import { MemorySessionStore } from "./store/memory";

describe("session plugin intercept integration", () => {
  it("routes by meta.source=send in a unified on handler", async () => {
    const tagPlugin: AgentPlugin = {
      on: ({ event }) => {
        if (event.type !== "user-text" || event.meta?.source !== "send") {
          return;
        }
        if (typeof event.text !== "string") {
          return;
        }
        return {
          action: "transform",
          event: { ...event, text: `<user>\n${event.text}\n</user>` },
        };
      },
    };
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [tagPlugin],
    });

    const events = await collect(await agent.send("hello"));

    expect(events[0]).toEqual(sentUserText("<user>\nhello\n</user>"));
  });

  it("keeps deprecated events.on observe-only", async () => {
    const seen: string[] = [];
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [
        {
          events: {
            on: ({ event }) => {
              seen.push(event.type);
            },
          },
        },
      ],
    });

    await collect(await agent.send("hello"));

    expect(seen).toContain("user-text");
    expect(seen).toContain("turn-end");
  });

  it("still surfaces plugin failures on turn-end as turn-error", async () => {
    const agent = new Agent({
      plugins: [
        {
          on: ({ event }) => {
            if (event.type === "turn-end") {
              throw new Error("turn-end plugin failed");
            }
          },
        },
      ],
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    const events = await collect(
      await agent.session("terminal-plugin").send("first")
    );

    expect(eventTypes(events)).toContain("turn-error");
  });

  it("observer events still reach plugins", async () => {
    const pluginEventTypes: string[] = [];
    const session = new AgentSession(
      {
        model: createCallbackModel(() =>
          Promise.resolve([assistantMessage("DONE")])
        ),
      },
      { key: "observer-intercept", store: new MemorySessionStore() },
      [
        {
          on: ({ event }) => {
            pluginEventTypes.push(event.type);
          },
        },
      ]
    );

    const run = await session.send("hello");
    const iterator = run.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await session.emitObserverEvent({
      text: "observer reasoning",
      type: "assistant-reasoning",
    });
    await iterator.next();
    await iterator.return?.();

    expect(pluginEventTypes).toContain("assistant-reasoning");
  });

  it("matches emitted text to model history after transform", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
      plugins: [
        {
          on: ({ event }) => {
            if (event.type !== "user-text" || typeof event.text !== "string") {
              return;
            }
            return {
              action: "transform",
              event: { ...event, text: `X:${event.text}` },
            };
          },
        },
      ],
    });

    await collect(await agent.send("hello"));

    expect(seenHistory[0]).toEqual([
      userTextToModelMessage(userText("X:hello")),
    ]);
  });
});
