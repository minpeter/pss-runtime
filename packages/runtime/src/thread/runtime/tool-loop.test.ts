import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createScriptedModelOptions,
  toolCallPart,
  toolResultFor,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";

describe("Agent thread tool loop", () => {
  it("continues the model loop after a tool call result", async () => {
    const toolCall = toolCallPart("call-tool-loop-1");
    const modelOptions = createScriptedModelOptions([
      [assistantMessage([toolCall]), toolResultFor(toolCall)],
      [assistantMessage("DONE")],
    ]);
    const agent = new Agent(modelOptions);

    await collect(await agent.send("remember me"));

    expect(modelOptions.model.doGenerateCalls).toHaveLength(2);
    expect(
      JSON.stringify(modelOptions.model.doGenerateCalls[1]?.prompt)
    ).toContain("call-tool-loop-1");
  });
});
