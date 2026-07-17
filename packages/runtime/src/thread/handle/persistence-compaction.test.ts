import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect, SpyStore } from "./test-support";

const storedAssistantOutput = (text: string): ModelMessage => ({
  content: [{ providerOptions: undefined, text, type: "text" }],
  role: "assistant",
});

describe("Agent thread persistence compaction", () => {
  it("compacts model context without dropping full stored history", async () => {
    const store = new SpyStore();
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(`DONE ${seenHistory.length}`),
        ]);
      }),
    });
    const thread = agent.thread("compact");

    await collect(await thread.send("old"));
    await thread.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "old exchange summarized",
    });
    await collect(await thread.send("tail"));

    expect(seenHistory[1]).toEqual([
      expect.objectContaining({
        content:
          "The conversation history before this point was compacted into the following summary:\n<summary>\nold exchange summarized\n</summary>",
        role: "user",
      }),
      userTextToModelMessage(userText("tail")),
    ]);
    expect(store.threads.get("compact")?.state).toEqual({
      compactions: [
        {
          endSeqExclusive: 2,
          schemaVersion: 1,
          startSeq: 0,
          summary: { content: "old exchange summarized", role: "system" },
        },
      ],
      history: [
        userTextToModelMessage(userText("old")),
        storedAssistantOutput("DONE 1"),
        userTextToModelMessage(userText("tail")),
        storedAssistantOutput("DONE 2"),
      ],
      schemaVersion: 2,
    });
  });
});
