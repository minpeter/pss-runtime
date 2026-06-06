import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import { assistantMessage, userText } from "../test-fixtures";
import { userTextToModelMessage } from "./mapping";
import { collect } from "./session.test-support";

describe("Agent session runtime input hooks", () => {
  it("drains hook steering at turn-start, step-start, and step-end but not afterTurn", async () => {
    const seenHistory: ModelMessage[][] = [];
    let afterTurnRun:
      | Promise<Awaited<ReturnType<typeof session.steer>>>
      | undefined;
    let afterTurnSteered = false;
    let step = 0;
    let session: ReturnType<Agent["session"]>;
    const agent = new Agent({
      hooks: {
        afterStep: async ({ stepIndex }) => {
          if (stepIndex === 0) {
            await session.steer("after step steer");
          }
        },
        afterTurn: () => {
          if (!afterTurnSteered) {
            afterTurnSteered = true;
            afterTurnRun = session.steer("after turn steer");
          }
        },
        beforeStep: async ({ stepIndex }) => {
          if (stepIndex === 0) {
            await session.steer("before step steer");
          }
        },
        beforeTurn: async () => {
          await session.steer("before turn steer");
        },
      },
      llm: ({ history }) => {
        step += 1;
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(step === 1 ? "This could be final." : "DONE"),
        ]);
      },
    });
    session = agent.session("hook-steer");

    const events = await collect(await session.send("original"));

    expect(events).toContainEqual({
      input: { type: "user-text", text: "before turn steer" },
      placement: "turn-start",
      type: "runtime-input",
    });
    expect(events).toContainEqual({
      input: { type: "user-text", text: "before step steer" },
      placement: "step-start",
      type: "runtime-input",
    });
    expect(events).toContainEqual({
      input: { type: "user-text", text: "after step steer" },
      placement: "step-end",
      type: "runtime-input",
    });
    expect(events).not.toContainEqual({
      input: { type: "user-text", text: "after turn steer" },
      placement: "step-end",
      type: "runtime-input",
    });
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("before turn steer")),
        userTextToModelMessage(userText("before step steer")),
      ],
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("before turn steer")),
        userTextToModelMessage(userText("before step steer")),
        assistantMessage("This could be final."),
        userTextToModelMessage(userText("after step steer")),
      ],
    ]);
    if (!afterTurnRun) {
      throw new Error("expected afterTurn steer to start a new run");
    }
    const afterTurnEvents = await collect(await afterTurnRun);
    expect(afterTurnEvents[0]).toEqual({
      text: "after turn steer",
      type: "user-text",
    });
  });
});
