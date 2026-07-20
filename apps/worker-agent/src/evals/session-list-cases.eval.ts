import {
  LIST_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session/session-tools";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import { scriptedText } from "./scripted-model";
import {
  listCall,
  readCall,
  searchCall,
  sendCall,
} from "./session-case-scripted";
import {
  defineSessionCases,
  noSessionTools,
  type SessionCase,
} from "./session-case-support";

const sessionListCases = [
  {
    expectList: true,
    id: "worker-agent-session-list-recent",
    name: "lists recent sessions before summarizing",
    prompt: "최근에 어떤 대화를 했는지 요약해줘.",
    responseIncludes: ["최근", "Zephyr"],
    scriptedResults: [
      listCall("list-recent", { limit: 3 }),
      sendCall(
        "list-recent",
        "최근에는 Project Zephyr, DB migration, 인보이스 이야기가 있었어."
      ),
      scriptedText(""),
    ],
    toolOrder: [LIST_SESSIONS_TOOL_NAME, SEND_MESSAGE_TOOL_NAME],
  },
  {
    expectList: true,
    id: "worker-agent-session-list-then-read",
    name: "reads a selected recent session before answering details",
    prompt: "최근 대화 중 DB migration 세부 순서가 뭐였지?",
    readChannel: "telegram:database",
    responseIncludes: ["백업", "dry-run", "smoke"],
    scriptedResults: [
      listCall("list-then-read", { limit: 5 }),
      readCall("list-then-read", "telegram:database"),
      sendCall(
        "list-then-read",
        "DB migration은 백업, dry-run, read-only, migration, smoke test 순서였어."
      ),
      scriptedText(""),
    ],
    toolOrder: [
      LIST_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-search-no-results",
    name: "says when no prior session matches",
    notCalledTools: [READ_SESSION_TOOL_NAME],
    prompt: "전에 moon base 예산 이야기했었나?",
    realResponseIncludesAny: ["없", "안보", "못찾", "확인되지", "잡히지"],
    responseIncludes: ["관련", "기록", "없"],
    scriptedResults: [
      searchCall("no-results", "moon base 예산"),
      sendCall("no-results", "관련 기록은 없어."),
      scriptedText(""),
    ],
    searchIncludes: ["moon"],
    searchResultCount: 0,
    sessionTools: noSessionTools,
    toolOrder: [SEARCH_SESSIONS_TOOL_NAME, SEND_MESSAGE_TOOL_NAME],
  },
  {
    id: "worker-agent-session-no-hallucination-empty-search",
    name: "does not invent a memory when search is empty",
    notCalledTools: [READ_SESSION_TOOL_NAME],
    prompt: "전에 내 급여 계좌 정보를 말했는지 알려줘.",
    realResponseIncludesAny: ["없", "안보", "못찾", "확인되지", "공유하지"],
    responseIncludes: ["기록", "없"],
    scriptedResults: [
      searchCall("empty-sensitive", "급여 계좌"),
      sendCall("empty-sensitive", "이전 대화에서 관련 기록은 없어."),
      scriptedText(""),
    ],
    searchIncludes: ["급여"],
    searchResultCount: 0,
    sessionTools: noSessionTools,
    toolOrder: [SEARCH_SESSIONS_TOOL_NAME, SEND_MESSAGE_TOOL_NAME],
  },
  {
    expectList: true,
    id: "worker-agent-session-list-snippets-only",
    name: "summarizes recent snippets without reading details",
    notCalledTools: [READ_SESSION_TOOL_NAME],
    prompt: "최근 대화 주제만 간단히 나열해줘.",
    responseIncludes: ["Zephyr", "migration", "인보이스"],
    scriptedResults: [
      listCall("snippets-only", { limit: 3 }),
      sendCall(
        "snippets-only",
        "최근 주제는 Zephyr 출시, DB migration, 인보이스야."
      ),
      scriptedText(""),
    ],
    toolOrder: [LIST_SESSIONS_TOOL_NAME, SEND_MESSAGE_TOOL_NAME],
  },
] satisfies readonly SessionCase[];

defineSessionCases(sessionListCases);
