import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { definePlugin } from "../../plugins/api";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  sentUserText,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";

describe("thread plugin intercept integration", () => {
  it("routes by meta.source=send in a plugin input.accept handler", async () => {
    const tagPlugin = definePlugin((pss) => {
      pss.on("input.accept", (event) => {
        if (event.type !== "user-input" || event.meta?.source !== "send") {
          return;
        }
        if (!("text" in event) || typeof event.text !== "string") {
          return;
        }
        return {
          action: "transform",
          value: {
            ...event,
            text: `<user>\n${event.text}\n</user>`,
          },
        };
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [tagPlugin],
    });

    const events = await collect(await agent.send("hello"));

    expect(events[0]).toEqual(sentUserText("<user>\nhello\n</user>"));
  });

  it("observes plugin notification events", async () => {
    const seen: string[] = [];
    const observerPlugin = definePlugin((pss) => {
      pss.on("turn.start", (event) => {
        seen.push(event.type);
      });
      pss.on("turn.end", (event) => {
        seen.push(event.type);
      });
      pss.on("input.accept", (event) => {
        seen.push(event.type);
        return { action: "continue" };
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      plugins: [observerPlugin],
    });

    await collect(await agent.send("hello"));

    expect(seen).toContain("user-input");
    expect(seen).toContain("turn-end");
  });

  it("still surfaces plugin failures on turn-end as turn-error", async () => {
    const agent = await createAgent({
      plugins: [
        definePlugin((pss) => {
          pss.on("turn.end", () => {
            throw new Error("turn-end plugin failed");
          });
        }),
      ],
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    const events = await collect(
      await agent.thread("terminal-plugin").send("first")
    );

    expect(eventTypes(events)).toContain("turn-error");
  });

  it("matches emitted text to model history after transform", async () => {
    const seenHistory: ModelMessage[][] = [];
    const tagPlugin = definePlugin((pss) => {
      pss.on("input.accept", (event) => {
        if (
          event.type !== "user-input" ||
          !("text" in event) ||
          typeof event.text !== "string"
        ) {
          return;
        }
        return {
          action: "transform",
          value: { ...event, text: `X:${event.text}` },
        };
      });
    });
    const agent = await createAgent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
      plugins: [tagPlugin],
    });

    await collect(await agent.send("hello"));

    expect(seenHistory[0]).toEqual([
      userTextToModelMessage(userText("X:hello")),
    ]);
  });
});
