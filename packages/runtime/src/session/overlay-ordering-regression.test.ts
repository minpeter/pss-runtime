import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import { assistantMessage, userText } from "../test-fixtures";
import type { AgentEvent } from "./events";
import { userTextToModelMessage } from "./mapping";

describe("session overlay ordering regression", () => {
  it("keeps step-start overlay above duplicate current-turn and runtime input", async () => {
    const seenHistories: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistories.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const session = agent.session("duplicate-current-turn-overlay-order");
    const run = await session.send("same");
    const events: AgentEvent[] = [];
    let injectedAtStepStart = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "step-start" && !injectedAtStepStart) {
        injectedAtStepStart = true;
        await session.steer("same");
        await session.overlay("overlay");
      }
    }

    expect(events.map((event) => event.type)).toContain("overlay-accepted");
    expect(seenHistories).toEqual([
      [
        userTextToModelMessage(userText("overlay")),
        userTextToModelMessage(userText("same")),
        userTextToModelMessage(userText("same")),
      ],
    ]);
  });
});
