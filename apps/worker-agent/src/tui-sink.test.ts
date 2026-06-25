import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";

import { SEND_MESSAGE_TOOL_NAME } from "./tools";
import {
  createTuiMessageSink,
  deliverRemoteTuiTurn,
  deliverTuiTurn,
  TUI_DEBUG_ASSISTANT_PREFIX,
  TUI_DEBUG_TOOL_CALL_PREFIX,
  TUI_DEBUG_TOOL_RESULT_PREFIX,
  TUI_FAILURE_MESSAGE,
} from "./tui-sink";

describe("TUI channel sink", () => {
  it("writes assistant-visible messages only when the channel sink sends", async () => {
    const lines: string[] = [];
    const sink = createTuiMessageSink({
      writeLine: (line) => lines.push(line),
    });

    await expect(
      sink.send({ id: "local", kind: "tui" }, "hello")
    ).resolves.toEqual({
      messageId: "tui-1",
      channel: "tui:local",
    });
    expect(lines).toEqual(["apex: hello"]);
  });

  it("prints assistant-output debug lines after tool delivery", async () => {
    const lines: string[] = [];

    await expect(
      deliverTuiTurn({
        output: { writeLine: (line) => lines.push(line) },
        text: " hello ",
        thread: threadWithRun([
          sendMessageEvent(),
          { text: "assistant fallback", type: "assistant-output" },
        ]),
      })
    ).resolves.toEqual({ delivered: true });
    expect(lines).toEqual([
      "you: hello",
      `${TUI_DEBUG_TOOL_RESULT_PREFIX} send_message {"channel":"tui:local","delivered":true,"messageId":"msg-1"}`,
      `${TUI_DEBUG_ASSISTANT_PREFIX} assistant fallback`,
    ]);
  });

  it("prints tool debug lines when the model only calls send_message", async () => {
    const lines: string[] = [];

    await expect(
      deliverTuiTurn({
        output: { writeLine: (line) => lines.push(line) },
        text: "hello",
        thread: threadWithRun([
          toolCallEvent({
            text: "visible answer",
          }),
          sendMessageEvent(),
        ]),
      })
    ).resolves.toEqual({ delivered: true });
    expect(lines).toEqual([
      "you: hello",
      `${TUI_DEBUG_TOOL_CALL_PREFIX} send_message {"text":"visible answer"}`,
      `${TUI_DEBUG_TOOL_RESULT_PREFIX} send_message {"channel":"tui:local","delivered":true,"messageId":"msg-1"}`,
    ]);
  });

  it("prints labeled assistant-output debug lines", async () => {
    const lines: string[] = [];

    await expect(
      deliverTuiTurn({
        output: { writeLine: (line) => lines.push(line) },
        text: " hello ",
        thread: threadWithRun([
          { text: "thinking out loud", type: "assistant-output" },
          sendMessageEvent(),
        ]),
      })
    ).resolves.toEqual({ delivered: true });
    expect(lines).toEqual([
      "you: hello",
      `${TUI_DEBUG_ASSISTANT_PREFIX} thinking out loud`,
      `${TUI_DEBUG_TOOL_RESULT_PREFIX} send_message {"channel":"tui:local","delivered":true,"messageId":"msg-1"}`,
    ]);
  });

  it("prefixes every assistant-output debug line when model output is multiline", async () => {
    const lines: string[] = [];

    await expect(
      deliverTuiTurn({
        output: { writeLine: (line) => lines.push(line) },
        text: "hello",
        thread: threadWithRun([
          { text: "line one\nline two", type: "assistant-output" },
          sendMessageEvent(),
        ]),
      })
    ).resolves.toEqual({ delivered: true });
    expect(lines).toEqual([
      "you: hello",
      `${TUI_DEBUG_ASSISTANT_PREFIX} line one`,
      `${TUI_DEBUG_ASSISTANT_PREFIX} line two`,
      `${TUI_DEBUG_TOOL_RESULT_PREFIX} send_message {"channel":"tui:local","delivered":true,"messageId":"msg-1"}`,
    ]);
  });

  it("assistant-output debug lines do not satisfy delivery without send_message", async () => {
    const lines: string[] = [];

    await expect(
      deliverTuiTurn({
        output: { writeLine: (line) => lines.push(line) },
        text: "hello",
        thread: threadWithRuns([
          [{ text: "first draft", type: "assistant-output" }],
          [{ text: "second draft", type: "assistant-output" }],
        ]),
      })
    ).resolves.toEqual({
      delivered: false,
      error: "missing_send_message",
    });
    expect(lines).toEqual([
      "you: hello",
      `${TUI_DEBUG_ASSISTANT_PREFIX} first draft`,
      `${TUI_DEBUG_ASSISTANT_PREFIX} second draft`,
      TUI_FAILURE_MESSAGE,
    ]);
  });

  it("prints a system warning when no send_message result is delivered", async () => {
    const lines: string[] = [];

    await expect(
      deliverTuiTurn({
        output: { writeLine: (line) => lines.push(line) },
        text: "hello",
        thread: threadWithRuns([
          [{ text: "assistant fallback", type: "assistant-output" }],
          [{ text: "still assistant fallback", type: "assistant-output" }],
        ]),
      })
    ).resolves.toEqual({
      delivered: false,
      error: "missing_send_message",
    });
    expect(lines).toEqual([
      "you: hello",
      `${TUI_DEBUG_ASSISTANT_PREFIX} assistant fallback`,
      `${TUI_DEBUG_ASSISTANT_PREFIX} still assistant fallback`,
      TUI_FAILURE_MESSAGE,
    ]);
  });

  it("prints remote TUI messages returned from the worker channel response", async () => {
    const lines: string[] = [];

    await expect(
      deliverRemoteTuiTurn({
        client: {
          deliver: () =>
            Promise.resolve({
              delivered: true,
              messages: [
                {
                  messageId: "tui-1",
                  text: "first",
                  channel: "tui:local",
                },
                {
                  messageId: "tui-2",
                  text: "second",
                  channel: "tui:local",
                },
              ],
            }),
        },
        output: { writeLine: (line) => lines.push(line) },
        text: " hello ",
      })
    ).resolves.toEqual({
      delivered: true,
      messages: [
        {
          messageId: "tui-1",
          text: "first",
          channel: "tui:local",
        },
        {
          messageId: "tui-2",
          text: "second",
          channel: "tui:local",
        },
      ],
    });
    expect(lines).toEqual(["you: hello", "apex: first", "apex: second"]);
  });
});

function threadWithRun(events: readonly AgentEvent[]) {
  return threadWithRuns([events]);
}

function threadWithRuns(runs: readonly (readonly AgentEvent[])[]) {
  let nextRunIndex = 0;
  return {
    send: () => {
      const events = runs[nextRunIndex];
      nextRunIndex += 1;
      if (!events) {
        throw new Error("No test run queued.");
      }
      return Promise.resolve(runWithEvents(events));
    },
  };
}

function sendMessageEvent(): AgentEvent {
  return {
    output: {
      type: "json",
      value: {
        channel: "tui:local",
        delivered: true,
        messageId: "msg-1",
      },
    },
    toolCallId: "call-1",
    toolName: SEND_MESSAGE_TOOL_NAME,
    type: "tool-result",
  };
}

function toolCallEvent(input: unknown): AgentEvent {
  return {
    input,
    toolCallId: "call-1",
    toolName: SEND_MESSAGE_TOOL_NAME,
    type: "tool-call",
  };
}

function runWithEvents(events: readonly AgentEvent[]): AgentTurn {
  return {
    events: () => eventStream(events),
  };
}

async function* eventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  yield* events;
}
