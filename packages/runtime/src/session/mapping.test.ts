import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assistantMessage,
  toolCallPart,
  toolResultFor,
  userMessage,
  userText,
} from "../test-fixtures";
import type { AgentEvent, RuntimeInput } from "./events";
import type { UserInput } from "./input";
import {
  modelMessageToAgentEvents,
  userMessageToModelMessage,
  userTextToModelMessage,
} from "./mapping";

describe("session mapping", () => {
  it("exposes runtime-input as runtime-originated current-turn input", () => {
    const input = userText("runtime hint");
    const event: RuntimeInput = {
      type: "runtime-input",
      input,
      placement: "step-start",
    };
    const observed: AgentEvent = event;

    if (observed.type !== "runtime-input") {
      throw new Error("expected runtime-input event");
    }

    expectTypeOf(observed.input).toEqualTypeOf<UserInput>();
    expectTypeOf(observed.placement).toEqualTypeOf<
      "turn-start" | "step-start" | "step-end"
    >();
    expect(observed.input).toEqual(input);
    expect(observed.placement).toBe("step-start");
  });

  it("maps user text to an AI SDK user model message", () => {
    expect(userTextToModelMessage(userText("hello"))).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("maps multipart user text to AI SDK text content parts", () => {
    expect(
      userTextToModelMessage(userText(["context block", "user message"]))
    ).toEqual({
      role: "user",
      content: [
        { type: "text", text: "context block" },
        { type: "text", text: "user message" },
      ],
    });
  });

  it("maps user image input to a serializable AI SDK file part", () => {
    expect(
      userMessageToModelMessage(
        userMessage([
          { type: "text", text: "describe this" },
          {
            type: "image",
            image: "iVBORw0KGgo=",
            mediaType: "image/png",
          },
        ])
      )
    ).toEqual({
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "file", data: "iVBORw0KGgo=", mediaType: "image/png" },
      ],
    });
  });

  it("maps user-message metadata to AI SDK provider options", () => {
    expect(
      userMessageToModelMessage({
        ...userMessage([{ type: "text", text: "hello" }]),
        metadata: { openai: { cacheControl: { type: "ephemeral" } } },
      })
    ).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      providerOptions: {
        openai: { cacheControl: { type: "ephemeral" } },
      },
    });
  });

  it("maps user file input without non-JSON URL objects", () => {
    const message = userMessageToModelMessage(
      userMessage([
        {
          type: "file",
          data: "https://example.com/a.txt",
          filename: "a.txt",
          mediaType: "text/plain",
        },
        {
          type: "file",
          data: { type: "text", text: "inline document" },
          mediaType: "text/plain",
        },
      ])
    );

    expect(message).toEqual({
      role: "user",
      content: [
        {
          type: "file",
          data: "https://example.com/a.txt",
          filename: "a.txt",
          mediaType: "text/plain",
        },
        {
          type: "file",
          data: { type: "text", text: "inline document" },
          mediaType: "text/plain",
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
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

  it("does not project runtime-input from model output", () => {
    const eventTypes = modelMessageToAgentEvents(
      assistantMessage("runtime-input")
    ).map((event) => event.type);

    expect(eventTypes).toEqual(["assistant-text"]);
    expect(eventTypes).not.toContain("runtime-input");
  });

  it("does not project overlay events from model output", () => {
    const eventTypes = modelMessageToAgentEvents(
      assistantMessage("overlay-accepted overlay-expired")
    ).map((event) => event.type);

    expect(eventTypes).toEqual(["assistant-text"]);
    expect(eventTypes).not.toContain("overlay-accepted");
    expect(eventTypes).not.toContain("overlay-expired");
  });
});
