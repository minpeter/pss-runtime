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
            input: { text: "가능해. 바로 테스트해보자." },
            toolCallId: "call_send",
            toolName: SEND_MESSAGE_TOOL_NAME,
          }),
          scriptedText(""),
        ],
      }),
  },
  (it) => {
    it("sends visible replies through send_message", async (t) => {
      await t.run("eval 기능 테스트 가능해?");

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
          scriptedText("내부 초안만 작성됨"),
          scriptedToolCall({
            input: { text: "아까 답장이 안 보였을 수 있어. 다시 보낼게." },
            toolCallId: "call_recovery_send",
            toolName: SEND_MESSAGE_TOOL_NAME,
          }),
          scriptedText(""),
        ],
      }),
  },
  (it) => {
    it("recovers when the first turn misses send_message", async (t) => {
      await t.run("응답 하나 보내줘");

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
              text: "전에 Project Zephyr 출시 일정을 금요일로 맞췄어.",
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
      await t.run("전에 Project Zephyr 얘기 뭐였지?");

      t.calledTool(READ_SESSION_TOOL_NAME, {
        input: channelInputEquals("telegram:previous"),
      });
      t.calledTool(SEND_MESSAGE_TOOL_NAME, {
        input: textInputIncludesAny("금요일", "Friday", "friday"),
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
  snippet: "Project Zephyr 출시 일정은 금요일로 맞추자.",
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
          text: "Project Zephyr 일정 언제로 할까?",
        },
        {
          index: 1,
          role: "assistant",
          text: "금요일 출시 일정으로 맞추자.",
        },
      ],
    }),
} satisfies SessionTranscriptReader;
