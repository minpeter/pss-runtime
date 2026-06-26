import {
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session-tools";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import { scriptedText } from "./scripted-model";
import { readCall, searchCall, sendCall } from "./session-case-scripted";
import {
  defineSessionCases,
  type SessionCase,
  zephyrMissingTranscriptTools,
} from "./session-case-support";

const sessionRecallCases = [
  {
    id: "worker-agent-session-search-zephyr-detail",
    name: "searches and reads a project detail",
    prompt: "Project Zephyr 출시일이 언제였는지 기억해?",
    readChannel: "telegram:zephyr",
    realResponseIncludes: ["금요일"],
    responseIncludes: ["Zephyr", "금요일"],
    scriptedResults: [
      searchCall("zephyr-detail", "Project Zephyr 출시"),
      readCall("zephyr-detail", "telegram:zephyr"),
      sendCall(
        "zephyr-detail",
        "Project Zephyr는 금요일 오전 출시로 정리했어."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["zephyr"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-search-database-migration",
    name: "searches a database migration memory",
    prompt: "전에 데이터베이스 마이그레이션은 어떤 순서로 하자고 했어?",
    readChannel: "telegram:database",
    responseIncludes: ["백업", "dry-run"],
    scriptedResults: [
      searchCall("database", "데이터베이스 마이그레이션"),
      readCall("database", "telegram:database"),
      sendCall(
        "database",
        "전에 정한 순서는 백업, dry-run, read-only 전환, migration, smoke test였어."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["마이그레이션"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-search-billing-invoice",
    name: "searches a billing recipient",
    prompt: "6월 인보이스는 어디로 보내기로 했지?",
    readChannel: "telegram:billing",
    responseIncludes: ["finance@acme.example"],
    scriptedResults: [
      searchCall("billing", "6월 인보이스"),
      readCall("billing", "telegram:billing"),
      sendCall(
        "billing",
        "6월 인보이스는 finance@acme.example 로 보내기로 했어."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["인보이스"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-search-travel-plan",
    name: "searches a travel plan",
    prompt: "교토 둘째 날 일정 다시 알려줘.",
    readChannel: "telegram:kyoto",
    responseIncludes: ["아라시야마", "니시키"],
    scriptedResults: [
      searchCall("kyoto", "교토 둘째 날"),
      readCall("kyoto", "telegram:kyoto"),
      sendCall("kyoto", "교토 둘째 날은 아라시야마와 니시키 시장으로 잡았어."),
      scriptedText(""),
    ],
    searchIncludes: ["교토"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-read-missing",
    name: "handles a missing transcript after search",
    prompt: "Zephyr 대화 자세히 다시 읽어줘.",
    readChannel: "telegram:zephyr",
    readFound: false,
    realResponseIncludesAny: [
      "못",
      "안",
      "어려",
      "스니펫",
      "불러오지",
      "읽히지",
      "부족",
      "없",
      "어렵",
    ],
    responseIncludes: ["기록", "읽지", "못했어"],
    scriptedResults: [
      searchCall("read-missing", "Zephyr"),
      readCall("read-missing", "telegram:zephyr"),
      sendCall(
        "read-missing",
        "관련 항목은 찾았지만 transcript 기록을 읽지 못했어."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["zephyr"],
    sessionTools: zephyrMissingTranscriptTools,
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-web-search-memory",
    name: "uses session memory for a prior web-search discussion",
    prompt: "전에 웹검색 가능하다고 했는지 찾아봐.",
    readChannel: "telegram:web-search",
    responseIncludes: ["웹검색", "없"],
    scriptedResults: [
      searchCall("web-memory", "웹검색"),
      readCall("web-memory", "telegram:web-search"),
      sendCall(
        "web-memory",
        "전에 웹검색 도구가 없어서 실시간 확인은 못 한다고 안내했어."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["웹검색"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-search-with-limit",
    name: "uses a search limit when narrowing recall",
    prompt:
      "migration 관련 이전 대화 하나만 찾아서 답해줘. 검색 결과는 1개만 가져와.",
    readChannel: "telegram:database",
    responseIncludes: ["migration", "smoke"],
    scriptedResults: [
      searchCall("search-limit", "migration", { limit: 1 }),
      readCall("search-limit", "telegram:database"),
      sendCall(
        "search-limit",
        "migration은 smoke test까지 확인하는 흐름으로 정했어."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["migration"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-read-with-cursor",
    name: "uses read-session pagination inputs",
    prompt:
      "DB migration 대화에서 read_session은 before=1, limit=1로 앞부분만 읽어서 핵심을 알려줘.",
    readChannel: "telegram:database",
    realResponseIncludes: ["백업"],
    responseIncludes: ["앞부분", "백업"],
    scriptedResults: [
      searchCall("read-cursor", "database migration"),
      readCall("read-cursor", "telegram:database", { before: 1, limit: 1 }),
      sendCall(
        "read-cursor",
        "앞부분 핵심은 migration 전에 백업을 먼저 두는 거였어."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["migration"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
] satisfies readonly SessionCase[];

defineSessionCases(sessionRecallCases);
