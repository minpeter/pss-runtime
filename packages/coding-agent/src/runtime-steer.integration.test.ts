import { Agent, type RuntimeLlm } from "@minpeter/pss-runtime";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

describe("coding-agent runtime steering integration", () => {
  it("puts awaited turn-start steering in the first model history", async () => {
    const seenHistory: ModelMessage[][] = [];
    const llm: RuntimeLlm = ({ history }) => {
      seenHistory.push([...history]);
      return Promise.resolve([{ role: "assistant", content: "DONE" }]);
    };
    const agent = await Agent.create({ llm });
    const session = agent.session("bori-turn-context");
    const run = await session.send("original prompt");
    let addedTurnContext = false;

    for await (const event of run.events()) {
      if (event.type === "turn-start" && !addedTurnContext) {
        addedTurnContext = true;
        await session.steer("turnContext: prefer concise answer");
      }
    }

    expect(seenHistory).toEqual([
      [
        { role: "user", content: "original prompt" },
        { role: "user", content: "turnContext: prefer concise answer" },
      ],
    ]);
  });
});
