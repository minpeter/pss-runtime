import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  toolCallPart,
  toolResultFor,
  userText,
} from "../test-fixtures";
import { modelMessageToAgentEvents, userTextToModelMessage } from "./mapping";

describe("session mapping", () => {
  it("maps user text to an AI SDK user model message", () => {
    expect(userTextToModelMessage(userText("hello"))).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("projects assistant text and tool calls to public agent events", () => {
    const toolCall = toolCallPart("call-tool");

    expect(modelMessageToAgentEvents(assistantMessage("DONE"))).toEqual([
      { type: "assistant-text", text: "DONE" },
    ]);
    expect(
      modelMessageToAgentEvents(
        assistantMessage([
          { type: "text", text: "thinking aloud" },
          { type: "text", text: "" },
          toolCall,
        ])
      )
    ).toEqual([
      { type: "assistant-text", text: "thinking aloud" },
      { type: "tool-call", toolName: "test_tool" },
    ]);
  });

  it("does not project non-assistant messages to public agent events", () => {
    const toolCall = toolCallPart("call-tool");

    expect(
      modelMessageToAgentEvents(userTextToModelMessage(userText("hi")))
    ).toEqual([]);
    expect(modelMessageToAgentEvents(toolResultFor(toolCall))).toEqual([]);
  });
});
