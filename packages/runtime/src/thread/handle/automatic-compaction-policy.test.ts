import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import {
  agentWithAutoCompaction,
  nextMacrotask,
  storedAssistantOutput,
} from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";
import { AgentThread } from "./agent-thread";

const minMessagesError = /autoCompaction\.minMessages/;
const retainMessagesError = /autoCompaction\.retainMessages/;

describe("Agent thread automatic compaction policy", () => {
  it("is disabled by default", async () => {
    const store = new SpyStore();
    let calls = 0;
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage(`DONE ${calls}`)];
      }),
    });
    const thread = agent.thread("default-disabled");

    await collect(await thread.send("old"));
    await collect(await thread.send("next"));

    expect(calls).toBe(2);
    expect(store.threads.get("default-disabled")?.state).toEqual({
      history: [
        userTextToModelMessage(userText("old")),
        storedAssistantOutput("DONE 1"),
        userTextToModelMessage(userText("next")),
        storedAssistantOutput("DONE 2"),
      ],
      schemaVersion: 1,
    });
  });

  it("skips automatic compaction while history is below the threshold", async () => {
    const store = new SpyStore();
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: { minMessages: 8, retainMessages: 1 },
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("DONE")];
      }),
    });

    await collect(await agent.thread("below-threshold").send("small"));

    expect(calls).toBe(1);
    expect(store.threads.get("below-threshold")?.state).toEqual({
      history: [
        userTextToModelMessage(userText("small")),
        storedAssistantOutput("DONE"),
      ],
      schemaVersion: 1,
    });
  });

  it("rejects malformed automatic compaction thresholds during AgentOptions validation", () => {
    const model = createCallbackModel(() => [assistantMessage("unused")]);

    for (const minMessages of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        agentWithAutoCompaction({
          autoCompaction: { minMessages, retainMessages: 1 },
          model,
        })
      ).toThrow(minMessagesError);
    }

    expect(() =>
      agentWithAutoCompaction({
        autoCompaction: { minMessages: 2, retainMessages: 2 },
        model,
      })
    ).toThrow(retainMessagesError);
  });

  it("does not schedule automatic compaction for notify-only turns", async () => {
    const store = new SpyStore();
    const summaryStarted = createDeferred();
    let calls = 0;
    const thread = new AgentThread(
      {
        model: createCallbackModel(() => {
          calls += 1;
          if (calls === 1) {
            return [assistantMessage("first notification done")];
          }
          if (calls === 2) {
            return [assistantMessage("second notification done")];
          }
          summaryStarted.resolve();
          return [assistantMessage("unexpected notify summary")];
        }),
      },
      { key: "notify-only-auto-skip", store },
      { autoCompaction: { minMessages: 4, retainMessages: 2 } }
    );

    await collect(await thread.notify("first notification"));
    await collect(await thread.notify("second notification"));

    const result = await Promise.race([
      summaryStarted.promise.then(() => "summary-started" as const),
      nextMacrotask().then(() => "idle" as const),
    ]);

    expect(result).toBe("idle");
    expect(calls).toBe(2);
    expect(store.threads.get("notify-only-auto-skip")?.state).toEqual({
      history: [
        userTextToModelMessage(userText("first notification")),
        storedAssistantOutput("first notification done"),
        userTextToModelMessage(userText("second notification")),
        storedAssistantOutput("second notification done"),
      ],
      schemaVersion: 1,
    });
  });
});
