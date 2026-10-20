import type { SessionTranscriptMessage } from "../session/session-transcript";
import type { SessionSummary } from "../session-index/session-index";

export interface EvalSessionRecord {
  readonly keywords: readonly string[];
  readonly messages: readonly SessionTranscriptMessage[];
  readonly score: number;
  readonly sessionScopeKey?: string;
  readonly summary: SessionSummary;
}

export const projectZephyrRecord = {
  keywords: ["project", "zephyr", "friday", "Released", "launch"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "When do you like Project Zephyr release schedule?",
    },
    {
      index: 1,
      role: "assistant",
      text: "Let's launch on Friday morning and close the checklist on Thursday.",
    },
  ],
  score: 4,
  summary: {
    channel: { id: "zephyr", kind: "telegram" },
    conversationKey: "telegram:zephyr",
    lastSeenAt: Date.UTC(2026, 5, 25, 8),
    snippet: "The Project Zephyr launch schedule was set for Friday morning.",
    threadKey: "thread:telegram:zephyr",
    turnCount: 4,
  },
} satisfies EvalSessionRecord;

export const databaseMigrationRecord = {
  keywords: ["database", "migration", "in the database", "Get ready to "],
  messages: [
    {
      index: 0,
      role: "user",
      text: "Remind me of the database migration sequence.",
    },
    {
      index: 1,
      role: "assistant",
      text: "It was in the order of backup, dry-run, read-only conversion, migration, and smoke test.",
    },
  ],
  score: 5,
  summary: {
    channel: { id: "database", kind: "telegram" },
    conversationKey: "telegram:database",
    lastSeenAt: Date.UTC(2026, 5, 24, 22),
    snippet:
      "DB migration is performed up to the smoke test after backup and dry-run.",
    threadKey: "thread:telegram:database",
    turnCount: 6,
  },
} satisfies EvalSessionRecord;

export const billingRecord = {
  keywords: ["billing", "invoice", "Charge", "Invoice"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "Who did you decide to send the June invoice to?",
    },
    {
      index: 1,
      role: "assistant",
      text: "i decided to send it to finance@acme.example.",
    },
  ],
  score: 3,
  summary: {
    channel: { id: "billing", kind: "telegram" },
    conversationKey: "telegram:billing",
    lastSeenAt: Date.UTC(2026, 5, 23, 17),
    snippet: "The June invoice recipient is finance@acme.example.",
    threadKey: "thread:telegram:billing",
    turnCount: 3,
  },
} satisfies EvalSessionRecord;

export const kyotoTravelRecord = {
  keywords: ["kyoto", "Kyoto", "travel", "Travel"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "Where did you schedule the second day in Kyoto?",
    },
    {
      index: 1,
      role: "assistant",
      text: "The second day was held as Arashiyama and Nishiki markets.",
    },
  ],
  score: 2,
  summary: {
    channel: { id: "kyoto", kind: "telegram" },
    conversationKey: "telegram:kyoto",
    lastSeenAt: Date.UTC(2026, 5, 22, 11),
    snippet: "The second day in Kyoto is Arashiyama and Nishiki Market.",
    threadKey: "thread:telegram:kyoto",
    turnCount: 5,
  },
} satisfies EvalSessionRecord;

export const webSearchLimitRecord = {
  keywords: ["web", "search", "Web search", "search"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "Can you find the latest prices by searching the web?",
    },
    {
      index: 1,
      role: "assistant",
      text: "This worker doesn't have a web search tool, so it can't check the web in real time.",
    },
  ],
  score: 2,
  summary: {
    channel: { id: "web-search", kind: "telegram" },
    conversationKey: "telegram:web-search",
    lastSeenAt: Date.UTC(2026, 5, 21, 9),
    snippet:
      "He informed me that there is no web search tool, so I cannot check the web in real time.",
    threadKey: "thread:telegram:web-search",
    turnCount: 2,
  },
} satisfies EvalSessionRecord;

export const defaultSessionRecords = [
  projectZephyrRecord,
  databaseMigrationRecord,
  billingRecord,
  kyotoTravelRecord,
  webSearchLimitRecord,
] satisfies readonly EvalSessionRecord[];
