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

  it("projects assistant reasoning, text, and tool calls to public agent events", () => {
    const toolCall = toolCallPart("call-tool", "test_tool", {
      query: "latest OpenAI API updates",
    });

    expect(modelMessageToAgentEvents(assistantMessage("DONE"))).toEqual([
      { type: "assistant-text", text: "DONE" },
    ]);
    expect(
      modelMessageToAgentEvents(
        assistantMessage([
          { type: "reasoning", text: "search before answering" },
          { type: "reasoning", text: "" },
          { type: "text", text: "thinking aloud" },
          { type: "text", text: "" },
          toolCall,
        ])
      )
    ).toEqual([
      {
        type: "assistant-reasoning",
        text: "search before answering",
      },
      { type: "assistant-text", text: "thinking aloud" },
      {
        type: "tool-call",
        input: { query: "latest OpenAI API updates" },
        toolCallId: "call-tool",
        toolName: "test_tool",
      },
    ]);
  });

  it("emits assistant reasoning before visible output when providers return it later", () => {
    const toolCall = toolCallPart("call-after-answer");

    expect(
      modelMessageToAgentEvents(
        assistantMessage([
          { type: "text", text: "visible answer" },
          toolCall,
          { type: "reasoning", text: "internal trace" },
        ])
      )
    ).toEqual([
      { type: "assistant-reasoning", text: "internal trace" },
      { type: "assistant-text", text: "visible answer" },
      {
        type: "tool-call",
        input: {},
        toolCallId: "call-after-answer",
        toolName: "test_tool",
      },
    ]);
  });

  it("projects tool results to public agent events", () => {
    const toolCall = toolCallPart("call-tool");

    expect(modelMessageToAgentEvents(toolResultFor(toolCall))).toEqual([
      {
        type: "tool-result",
        output: { type: "json", value: {} },
        toolCallId: "call-tool",
        toolName: "test_tool",
      },
    ]);
  });

  it("does not project assistant-embedded tool results", () => {
    expect(
      modelMessageToAgentEvents(
        assistantMessage([
          {
            type: "tool-result",
            output: { type: "text", value: "provider executed" },
            toolCallId: "call-provider-tool",
            toolName: "test_tool",
          },
        ])
      )
    ).toEqual([]);
  });

  it("does not project user messages to public agent events", () => {
    expect(
      modelMessageToAgentEvents(userTextToModelMessage(userText("hi")))
    ).toEqual([]);
  });
});
