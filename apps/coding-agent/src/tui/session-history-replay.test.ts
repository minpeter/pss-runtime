import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  resumeSessionReplayParts,
  sessionHistoryReplayParts,
} from "./session-history-replay";

describe("sessionHistoryReplayParts", () => {
  it.each(["", " \t\n "])(
    "does not stage assistant or reasoning blocks for blank content %j",
    (text) => {
      expect(
        sessionHistoryReplayParts([
          { role: "assistant", content: text },
          {
            role: "assistant",
            content: [
              { type: "text", text },
              { type: "reasoning", text },
            ],
          },
        ])
      ).toEqual([{ type: "clear" }]);
    }
  );

  it("preserves visible text, reasoning and tool ordering around blank parts", () => {
    const content: ModelMessage[] = [
      { role: "assistant", content: " \nANSWER_SENTINEL\n " },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: " REASONING_SENTINEL " },
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "fixture",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "fixture",
            output: { type: "text", value: "RESULT_SENTINEL" },
          },
        ],
      },
    ];
    expect(
      sessionHistoryReplayParts([
        { role: "assistant", content: "" },
        ...content,
        { role: "assistant", content: [{ type: "reasoning", text: " \n" }] },
      ])
    ).toEqual(sessionHistoryReplayParts(content));
  });

  it("replays stored user and assistant messages in order", () => {
    const history: readonly ModelMessage[] = [
      { content: "hello", role: "user" },
      { content: "welcome back", role: "assistant" },
    ];

    expect(sessionHistoryReplayParts(history)).toEqual([
      { type: "clear" },
      { text: "hello", type: "user" },
      { part: { type: "text-start" }, type: "stream" },
      {
        part: { text: "welcome back", type: "text-delta" },
        type: "stream",
      },
      { part: { type: "text-end" }, type: "stream" },
    ]);
  });

  it("clears stale transcript content for empty histories", () => {
    expect(sessionHistoryReplayParts([])).toEqual([{ type: "clear" }]);
  });

  it("switches sessions before loading and replaying durable history", async () => {
    const events: string[] = [];
    const history: readonly ModelMessage[] = [
      { content: "hello", role: "user" },
      { content: "welcome back", role: "assistant" },
    ];
    const replay = await resumeSessionReplayParts(
      {
        loadCurrentHistory: vi.fn(() => {
          events.push("load");
          return Promise.resolve(history);
        }),
        switchSession: vi.fn((sessionKey) => {
          events.push(`switch:${sessionKey}`);
          return Promise.resolve();
        }),
      },
      "session-2"
    );

    expect(events).toEqual(["switch:session-2", "load"]);
    expect(replay).toContainEqual({ text: "hello", type: "user" });
    expect(replay).toContainEqual({
      part: { text: "welcome back", type: "text-delta" },
      type: "stream",
    });
  });
});
