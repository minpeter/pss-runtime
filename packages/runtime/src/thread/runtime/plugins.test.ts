import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  sentUserText,
  steerRuntimeInput,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent thread runtime input plugins", () => {
  it("drains event-plugin steering at turn-start, step-start, and step-end but starts a new run after turn-end", async () => {
    const seenHistory: ModelMessage[][] = [];
    let turnEndRun:
      | Promise<Awaited<ReturnType<typeof thread.steer>>>
      | undefined;
    let turnEndSteered = false;
    let step = 0;
    let thread: ReturnType<Agent["thread"]>;
    const agent = new Agent({
      plugins: [
        {
          on: async ({ event }) => {
            if (event.type === "turn-start") {
              await thread.steer("turn start steer");
              return;
            }

            if (event.type === "step-start" && step === 0) {
              await thread.steer("step start steer");
              return;
            }

            if (event.type === "step-end" && step === 1) {
              await thread.steer("step end steer");
              return;
            }

            if (event.type === "turn-end" && !turnEndSteered) {
              turnEndSteered = true;
              turnEndRun = thread.steer("turn end steer");
            }
          },
        },
      ],
      model: createCallbackModel(({ history }) => {
        step += 1;
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(step === 1 ? "This could be final." : "DONE"),
        ]);
      }),
    });
    thread = agent.thread("plugin-steer");

    const events = await collect(await thread.send("original"));

    expect(events).toContainEqual(
      steerRuntimeInput("turn start steer", "turn-start")
    );
    expect(events).toContainEqual(
      steerRuntimeInput("step start steer", "step-start")
    );
    expect(events).toContainEqual(
      steerRuntimeInput("step end steer", "step-end")
    );
    expect(events).not.toContainEqual(
      steerRuntimeInput("turn end steer", "step-end")
    );
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("turn start steer")),
        userTextToModelMessage(userText("step start steer")),
      ],
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("turn start steer")),
        userTextToModelMessage(userText("step start steer")),
        assistantMessage("This could be final."),
        userTextToModelMessage(userText("step end steer")),
      ],
    ]);
    if (!turnEndRun) {
      throw new Error("expected turn-end steer to start a new run");
    }
    const turnEndEvents = await collect(await turnEndRun);
    expect(turnEndEvents[0]).toEqual(sentUserText("turn end steer"));
  });
});
