import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent";
import type { RuntimeLlm } from "./llm";
import { assistantMessage, userText } from "./test-fixtures";

const fakeModel = {} as LanguageModel;
const childRuntimeModel: RuntimeLlm = async () => [
  assistantMessage("CHILD DONE"),
];

describe("registerSubagents", () => {
  it("registers wrapped subagents and delegates session send", async () => {
    const child = new Agent({
      model: childRuntimeModel,
      namespace: "researcher",
    } as AgentOptions);
    const parent = new Agent({
      model: fakeModel,
      subagents: [
        {
          agent: child,
          description: "Researches facts.",
          name: "researcher",
        },
      ],
    });

    expect(parent.subagentCount).toBe(1);
    await expect(parent.send(userText("hello"))).resolves.toBeDefined();
  });
});
