import type { SessionSummary } from "../session-index";
import type { SessionTranscriptMessage } from "../session-transcript";

export interface EvalSessionRecord {
  readonly keywords: readonly string[];
  readonly messages: readonly SessionTranscriptMessage[];
  readonly score: number;
  readonly sessionScopeKey?: string;
  readonly summary: SessionSummary;
}

export const projectZephyrRecord = {
  keywords: ["project", "zephyr", "금요일", "출시", "launch"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "Project Zephyr 출시 일정은 언제가 좋아?",
    },
    {
      index: 1,
      role: "assistant",
      text: "금요일 오전에 출시하고 목요일에는 체크리스트만 닫자.",
    },
  ],
  score: 4,
  summary: {
    channel: { id: "zephyr", kind: "telegram" },
    conversationKey: "telegram:zephyr",
    lastSeenAt: Date.UTC(2026, 5, 25, 8),
    snippet: "Project Zephyr 출시 일정은 금요일 오전으로 정리했다.",
    threadKey: "thread:telegram:zephyr",
    turnCount: 4,
  },
} satisfies EvalSessionRecord;

export const databaseMigrationRecord = {
  keywords: ["database", "migration", "데이터베이스", "마이그레이션"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "데이터베이스 마이그레이션 순서 다시 알려줘.",
    },
    {
      index: 1,
      role: "assistant",
      text: "백업, dry-run, read-only 전환, migration, smoke test 순서였어.",
    },
  ],
  score: 5,
  summary: {
    channel: { id: "database", kind: "telegram" },
    conversationKey: "telegram:database",
    lastSeenAt: Date.UTC(2026, 5, 24, 22),
    snippet: "DB migration은 백업과 dry-run 이후 smoke test까지 진행한다.",
    threadKey: "thread:telegram:database",
    turnCount: 6,
  },
} satisfies EvalSessionRecord;

export const billingRecord = {
  keywords: ["billing", "invoice", "청구", "인보이스"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "6월 인보이스는 누구에게 보내기로 했지?",
    },
    {
      index: 1,
      role: "assistant",
      text: "finance@acme.example 로 보내기로 정리했어.",
    },
  ],
  score: 3,
  summary: {
    channel: { id: "billing", kind: "telegram" },
    conversationKey: "telegram:billing",
    lastSeenAt: Date.UTC(2026, 5, 23, 17),
    snippet: "6월 인보이스 수신자는 finance@acme.example 이다.",
    threadKey: "thread:telegram:billing",
    turnCount: 3,
  },
} satisfies EvalSessionRecord;

export const kyotoTravelRecord = {
  keywords: ["kyoto", "교토", "travel", "여행"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "교토 일정에서 둘째 날은 어디로 잡았지?",
    },
    {
      index: 1,
      role: "assistant",
      text: "둘째 날은 아라시야마와 니시키 시장으로 잡았어.",
    },
  ],
  score: 2,
  summary: {
    channel: { id: "kyoto", kind: "telegram" },
    conversationKey: "telegram:kyoto",
    lastSeenAt: Date.UTC(2026, 5, 22, 11),
    snippet: "교토 둘째 날 일정은 아라시야마와 니시키 시장이다.",
    threadKey: "thread:telegram:kyoto",
    turnCount: 5,
  },
} satisfies EvalSessionRecord;

export const webSearchLimitRecord = {
  keywords: ["web", "search", "웹검색", "검색"],
  messages: [
    {
      index: 0,
      role: "user",
      text: "웹검색으로 최신 가격을 확인할 수 있어?",
    },
    {
      index: 1,
      role: "assistant",
      text: "이 worker에는 웹검색 도구가 없어서 실시간 웹 확인은 못 해.",
    },
  ],
  score: 2,
  summary: {
    channel: { id: "web-search", kind: "telegram" },
    conversationKey: "telegram:web-search",
    lastSeenAt: Date.UTC(2026, 5, 21, 9),
    snippet: "웹검색 도구가 없어 실시간 웹 확인은 못 한다고 안내했다.",
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
