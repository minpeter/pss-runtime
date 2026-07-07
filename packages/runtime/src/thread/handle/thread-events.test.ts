import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryExecutionHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { collect } from "./test-support";

describe("AgentThread durable event replay", () => {
  it("replays committed thread events with cursor pagination", async () => {
    const host = createInMemoryExecutionHost();
    const agent = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    });
    const thread = agent.thread("durable-events");

    await collect(await thread.send("hello"));

    const firstPage = await collectThreadEvents(thread.events({ limit: 3 }));
    expect(firstPage.map((record) => record.event.type)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
    ]);
    expect(firstPage.map((record) => record.cursor.offset)).toEqual([1, 2, 3]);
    expect(firstPage.map((record) => record.threadKey)).toEqual([
      "durable-events",
      "durable-events",
      "durable-events",
    ]);

    const lastRecord = firstPage.at(-1);
    if (!lastRecord) {
      throw new Error("expected first replay page");
    }

    const secondPage = await collectThreadEvents(
      thread.events({ after: lastRecord.cursor })
    );
    expect(secondPage.map((record) => record.event.type)).toEqual([
      "assistant-output",
      "step-end",
      "turn-end",
    ]);
    expect(secondPage.map((record) => record.cursor.offset)).toEqual([4, 5, 6]);
  });
});

async function collectThreadEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
