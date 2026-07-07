import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import {
  agentWithAutoCompaction,
  storedAssistantOutput,
} from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";

describe("Agent thread automatic compaction overflow recovery", () => {
  it("rejects before provider calls when the context gate overflows with error", async () => {
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: {
        contextGate: {
          estimateTokens: () => 2,
          maxInputTokens: 1,
          onOverflow: "error",
        },
        minMessages: 5,
        retainMessages: 2,
      },
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("unexpected")];
      }),
    });

    const events = await collect(
      await agent.thread("gate-error").send("too much")
    );

    expect(calls).toBe(0);
    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
    expect(events.at(-1)).toMatchObject({
      message: expect.stringContaining("context gate"),
      type: "turn-error",
    });
  });

  it("compacts before retrying a context gate overflow", async () => {
    const store = new SpyStore();
    const providerHistories: ModelMessage[][] = [];
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: {
        contextGate: {
          estimateTokens: ({ messages }) => (messages.length > 3 ? 100 : 1),
          maxInputTokens: 10,
          onOverflow: "compact",
        },
        minMessages: 5,
        retainMessages: 2,
      },
      host: { kind: "thread", threadStore: store },
      model: createCallbackModel(({ history }) => {
        calls += 1;
        providerHistories.push([...history]);
        if (calls === 1) {
          return [assistantMessage("old done")];
        }
        if (calls === 2) {
          return [assistantMessage("tail done")];
        }
        if (calls === 3) {
          return [assistantMessage("old exchange summarized")];
        }
        return [assistantMessage("after gated compaction")];
      }),
    });
    const thread = agent.thread("gate-compact");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    const events = await collect(await thread.send("next"));

    expect(eventTypes(events)).toContain("turn-end");
    expect(events).toContainEqual({
      text: "after gated compaction",
      type: "assistant-output",
    });
    expect(calls).toBe(4);
    expect(providerHistories).not.toContainEqual([
      userTextToModelMessage(userText("old")),
      assistantMessage("old done"),
      userTextToModelMessage(userText("tail")),
      assistantMessage("tail done"),
      userTextToModelMessage(userText("next")),
    ]);
    expect(providerHistories.at(-1)).toEqual([
      { content: "old exchange summarized", role: "system" },
      userTextToModelMessage(userText("tail")),
      assistantMessage("tail done"),
      userTextToModelMessage(userText("next")),
    ]);
  });

  it("blocks for compaction and retries once when the model overflows context", async () => {
    const store = new SpyStore();
    const retryHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: { minMessages: 5, retainMessages: 2 },
      host: { kind: "thread", threadStore: store },
      model: createCallbackModel(({ history }) => {
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("old done")];
        }
        if (calls === 2) {
          return [assistantMessage("tail done")];
        }
        if (calls === 3) {
          throw new Error("context_length_exceeded: too many tokens");
        }
        if (calls === 4) {
          return [assistantMessage("old exchange summarized")];
        }
        retryHistory.push([...history]);
        return [assistantMessage("after blocking compaction")];
      }),
    });
    const thread = agent.thread("blocking-overflow");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    const events = await collect(await thread.send("next"));

    expect(eventTypes(events)).toContain("turn-end");
    expect(events).toContainEqual({
      text: "after blocking compaction",
      type: "assistant-output",
    });
    expect(retryHistory[0]).toEqual([
      { content: "old exchange summarized", role: "system" },
      userTextToModelMessage(userText("tail")),
      assistantMessage("tail done"),
      userTextToModelMessage(userText("next")),
    ]);
    expect(store.threads.get("blocking-overflow")?.state).toMatchObject({
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
        storedAssistantOutput("old done"),
        userTextToModelMessage(userText("tail")),
        storedAssistantOutput("tail done"),
        userTextToModelMessage(userText("next")),
        storedAssistantOutput("after blocking compaction"),
      ],
    });
  });
});
