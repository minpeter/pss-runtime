import {
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session/session-tools";
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
    prompt: "Remember when Project Zephyr launched?",
    readChannel: "telegram:zephyr",
    realResponseIncludes: ["friday"],
    responseIncludes: ["Zephyr", "friday"],
    scriptedResults: [
      searchCall("zephyr-detail", "Project Zephyr Launch"),
      readCall("zephyr-detail", "telegram:zephyr"),
      sendCall(
        "zephyr-detail",
        "Project Zephyr wrapped it up with a Friday morning release."
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
    prompt: "In what order did you ask to migrate the database before?",
    readChannel: "telegram:database",
    responseIncludes: ["Backup", "dry-run"],
    scriptedResults: [
      searchCall("database", "Database migrated."),
      readCall("database", "telegram:database"),
      sendCall(
        "database",
        "The order I set before was backup, dry-run, read-only conversion, migration, and smoke test."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["Get ready to "],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-search-billing-invoice",
    name: "searches a billing recipient",
    prompt: "Where did you decide to send the June invoice?",
    readChannel: "telegram:billing",
    responseIncludes: ["finance@acme.example"],
    scriptedResults: [
      searchCall("billing", "June Invoice"),
      readCall("billing", "telegram:billing"),
      sendCall(
        "billing",
        "I decided to send the June invoice to finance@acme.example."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["Invoice"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-search-travel-plan",
    name: "searches a travel plan",
    prompt: "Remind me of the schedule for the second day in Kyoto.",
    readChannel: "telegram:kyoto",
    responseIncludes: ["Arashiyama", "Nishiki"],
    scriptedResults: [
      searchCall("kyoto", "2nd day in Kyoto"),
      readCall("kyoto", "telegram:kyoto"),
      sendCall(
        "kyoto",
        "I caught the second day in Kyoto with Arashiyama and Nishiki Market."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["Kyoto"],
    toolOrder: [
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ],
  },
  {
    id: "worker-agent-session-read-missing",
    name: "handles a missing transcript after search",
    prompt: "Read the Zephyr conversation again.",
    readChannel: "telegram:zephyr",
    readFound: false,
    realResponseIncludesAny: [
      "鐵釘",
      "In",
      "Young",
      "Snippet",
      "Loading page",
      "Unread",
      "Tribe",
      "none",
      "Difficult",
    ],
    responseIncludes: ["Record", "Unread", "I couldn't do it"],
    scriptedResults: [
      searchCall("read-missing", "Zephyr"),
      readCall("read-missing", "telegram:zephyr"),
      sendCall(
        "read-missing",
        "I found a related item, but I couldn't read the transcript record."
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
    prompt: "Find out if you said you can search the web before.",
    readChannel: "telegram:web-search",
    responseIncludes: ["Web search", "none"],
    scriptedResults: [
      searchCall("web-memory", "Web search"),
      readCall("web-memory", "telegram:web-search"),
      sendCall(
        "web-memory",
        "They told me before that there is no web search tool, so I can't check it in real time."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["Web search"],
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
      "find and answer one previous conversation about migration. Get only 1 result.",
    readChannel: "telegram:database",
    responseIncludes: ["migration", "smoke"],
    scriptedResults: [
      searchCall("search-limit", "migration", { limit: 1 }),
      readCall("search-limit", "telegram:database"),
      sendCall(
        "search-limit",
        "the migration is set as a flow to check up to the smoke test."
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
      "In the DB migration conversation, the read_session is before = 1, limit = 1. Read only the first part to get the point across.",
    readChannel: "telegram:database",
    realResponseIncludes: ["Backup"],
    responseIncludes: ["Anterior part", "Backup"],
    scriptedResults: [
      searchCall("read-cursor", "database migration"),
      readCall("read-cursor", "telegram:database", { before: 1, limit: 1 }),
      sendCall(
        "read-cursor",
        "The core of the first part was to put the backup first before migration."
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
