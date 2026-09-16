import { defineEval } from "@minpeter/pss-runtime/evals";
import {
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session/session-tools";
import type { SessionTranscriptReader } from "../session/session-transcript";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import {
  channelInputEquals,
  hasNonEmptyTextInput,
  textInputIncludesAny,
} from "./eval-matchers";
import { scriptedText, scriptedToolCall } from "./scripted-model";
import { workerEvalThread } from "./thread";

defineEval(
  "worker-agent-delivery",
  {
    tags: ["worker-agent", "delivery"],
    thread: () =>
      workerEvalThread({
        scriptedResults: [
          scriptedToolCall({
            input: { text: "It's possible. Let's test it right away." },
            toolCallId: "call_send",
            toolName: SEND_MESSAGE_TOOL_NAME,
          }),
          scriptedText(""),
        ],
      }),
  },
  (it) => {
    it("sends visible replies through send_message", async (t) => {
      await t.run("can you test the eval function?");

      t.calledTool(SEND_MESSAGE_TOOL_NAME, {
        input: hasNonEmptyTextInput,
      });
      t.completed();
      t.noFailedActions();
      t.maxToolCalls(1);
    });
  }
);

defineEval(
  "worker-agent-delivery-recovery",
  {
    tags: ["worker-agent", "delivery"],
    thread: () =>
      workerEvalThread({
        scriptedResults: [
          scriptedText("Internal draft only"),
          scriptedToolCall({
            input: {
              text: "I may not have seen your reply before. I'll send it again.",
            },
            toolCallId: "call_recovery_send",
            toolName: SEND_MESSAGE_TOOL_NAME,
          }),
          scriptedText(""),
        ],
      }),
  },
  (it) => {
    it("recovers when the first turn misses send_message", async (t) => {
      await t.run("Send me a response.");

      t.calledTool(SEND_MESSAGE_TOOL_NAME, {
        input: hasNonEmptyTextInput,
        times: 1,
      });
      t.completed();
      t.noFailedActions();
    });
  }
);

defineEval(
  "worker-agent-session-recall",
  {
    tags: ["worker-agent", "sessions"],
    thread: () =>
      workerEvalThread({
        scriptedResults: [
          scriptedToolCall({
            input: { query: "Project Zephyr" },
            toolCallId: "call_search",
            toolName: SEARCH_SESSIONS_TOOL_NAME,
          }),
          scriptedToolCall({
            input: { channel: "telegram:previous" },
            toolCallId: "call_read",
            toolName: READ_SESSION_TOOL_NAME,
          }),
          scriptedToolCall({
            input: {
              text: "We had a Project Zephyr launch scheduled for Friday before.",
            },
            toolCallId: "call_send_session",
            toolName: SEND_MESSAGE_TOOL_NAME,
          }),
          scriptedText(""),
        ],
        sessionTools: {
          currentConversationKey: () => "tui:eval",
          reader: {
            canRead: (conversationKey) =>
              Promise.resolve(conversationKey === "telegram:previous"),
            list: () => Promise.resolve([sessionSummary]),
            search: () => Promise.resolve([sessionSearchResult]),
          },
          transcriptReader: sessionTranscriptReader,
        },
      }),
  },
  (it) => {
    it("reads the prior session and answers with the seeded launch day", async (t) => {
      await t.run("What was Project Zephyr talking about before?");

      t.calledTool(READ_SESSION_TOOL_NAME, {
        input: channelInputEquals("telegram:previous"),
      });
      t.calledTool(SEND_MESSAGE_TOOL_NAME, {
        input: textInputIncludesAny("friday", "Friday", "friday"),
      });
      t.completed();
      t.noFailedActions();
    });
  }
);

const sessionSummary = {
  channel: { id: "previous", kind: "telegram" },
  conversationKey: "telegram:previous",
  lastSeenAt: Date.UTC(2026, 5, 25),
  snippet: "Let's meet the Project Zephyr launch schedule for Friday.",
  threadKey: "thread:telegram:previous",
  turnCount: 2,
} as const;

const sessionSearchResult = {
  ...sessionSummary,
  score: 3,
} as const;

const sessionTranscriptReader = {
  read: (conversationKey) =>
    Promise.resolve({
      conversationKey,
      found: true,
      hasMore: false,
      messageCount: 2,
      messages: [
        {
          index: 0,
          role: "user",
          text: "When should I schedule Project Zephyr?",
        },
        {
          index: 1,
          role: "assistant",
          text: "Let's meet the release schedule for Friday.",
        },
      ],
    }),
} satisfies SessionTranscriptReader;
