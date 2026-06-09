import { describe, expect, it, vi } from "vitest";
import {
  assistantTextFromAlarmSummary,
  deliverAlarmAssistantText,
} from "./alarm-delivery";

function createTelegramFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    json: async () => ({
      ok: true,
      result: {
        chat: { id: 1, type: "private" },
        date: 1,
        from: {
          first_name: "Bot",
          id: 2,
          is_bot: true,
          username: "pss_agent",
        },
        message_id: 1,
        text: "ok",
      },
    }),
    ok: true,
  });
}

describe("alarm delivery", () => {
  it("extracts assistant text from alarm summary events", () => {
    expect(
      assistantTextFromAlarmSummary({
        consumedSessionPrompts: [],
        continuationReasons: [],
        continuationScheduled: false,
        droppedEvents: 0,
        events: [{ text: "Background done.", type: "assistant-text" }],
        failedRuns: [],
        failedSessionPrompts: [],
        markers: [],
        remainingRuns: 0,
        remainingSessionPrompts: 0,
        resumedRuns: [],
      })
    ).toBe("Background done.");
  });

  it("posts telegram follow-up messages for alarm assistant text", async () => {
    const fetchMock = createTelegramFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const bubbles = await deliverAlarmAssistantText({
      bindings: { TELEGRAM_BOT_TOKEN: "bot-token" },
      route: {
        chatId: "chat-1",
        sessionKey: "session-1",
        storePrefix: "prefix-1",
        userId: "user-1",
      },
      summary: {
        consumedSessionPrompts: [],
        continuationReasons: [],
        continuationScheduled: false,
        droppedEvents: 0,
        events: [{ text: "First.\n\nSecond.", type: "assistant-text" }],
        failedRuns: [],
        failedSessionPrompts: [],
        markers: [],
        remainingRuns: 0,
        remainingSessionPrompts: 0,
        resumedRuns: [],
      },
    });

    expect(bubbles).toEqual(["First.", "Second."]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("posts block-tagged alarm text as a single telegram message", async () => {
    const fetchMock = createTelegramFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const bubbles = await deliverAlarmAssistantText({
      bindings: { TELEGRAM_BOT_TOKEN: "bot-token" },
      route: {
        chatId: "chat-1",
        sessionKey: "session-1",
        storePrefix: "prefix-1",
        userId: "user-1",
      },
      summary: {
        consumedSessionPrompts: [],
        continuationReasons: [],
        continuationScheduled: false,
        droppedEvents: 0,
        events: [{ text: "<block>X\n\nY</block>", type: "assistant-text" }],
        failedRuns: [],
        failedSessionPrompts: [],
        markers: [],
        remainingRuns: 0,
        remainingSessionPrompts: 0,
        resumedRuns: [],
      },
    });

    expect(bubbles).toEqual(["X\n\nY"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
