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
    prompt: "Summarize what you've been talking about lately.",
    responseIncludes: ["Recently ", "Zephyr"],
    scriptedResults: [
      listCall("list-recent", { limit: 3 }),
      sendCall(
        "list-recent",
        "Recently, there has been talk of Project Zephyr, DB migration, and invoices."
      ),
      scriptedText(""),
    ],
    toolOrder: [LIST_SESSIONS_TOOL_NAME, SEND_MESSAGE_TOOL_NAME],
  },
  {
    expectList: true,
    id: "worker-agent-session-list-then-read",
    name: "reads a selected recent session before answering details",
    prompt:
      "What was the detailed sequence of DB migration during the recent conversation?",
    readChannel: "telegram:database",
    responseIncludes: ["Backup", "dry-run", "smoke"],
    scriptedResults: [
      listCall("list-then-read", { limit: 5 }),
      readCall("list-then-read", "telegram:database"),
      sendCall(
        "list-then-read",
        "DB migration was in the order of backup, dry-run, read-only, migration, and smoke test."
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
    prompt: "Did we talk about the moon base budget before?",
    realResponseIncludesAny: [
      "none",
      "Security",
      "Not found",
      "Unverified",
      "will not be caught",
    ],
    responseIncludes: ["relacion coneccion", "Record", "none"],
    scriptedResults: [
      searchCall("no-results", "moon base budget"),
      sendCall("no-results", "There are no related records."),
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
    prompt: "Let me know if you told me my payroll account information before.",
    realResponseIncludesAny: [
      "none",
      "Security",
      "Not found",
      "Unverified",
      "Don't share",
    ],
    responseIncludes: ["Record", "none"],
    scriptedResults: [
      searchCall("empty-sensitive", "Payroll Account"),
      sendCall(
        "empty-sensitive",
        "There is no relevant record from the previous conversation."
      ),
      scriptedText(""),
    ],
    searchIncludes: ["Salary"],
    searchResultCount: 0,
    sessionTools: noSessionTools,
    toolOrder: [SEARCH_SESSIONS_TOOL_NAME, SEND_MESSAGE_TOOL_NAME],
  },
  {
    expectList: true,
    id: "worker-agent-session-list-snippets-only",
    name: "summarizes recent snippets without reading details",
    notCalledTools: [READ_SESSION_TOOL_NAME],
    prompt: "Briefly list only the topics of recent conversations.",
    responseIncludes: ["Zephyr", "migration", "Invoice"],
    scriptedResults: [
      listCall("snippets-only", { limit: 3 }),
      sendCall(
        "snippets-only",
        "Recent topics include Zephyr launch, DB migration, and invoices."
      ),
      scriptedText(""),
    ],
    toolOrder: [LIST_SESSIONS_TOOL_NAME, SEND_MESSAGE_TOOL_NAME],
  },
] satisfies readonly SessionCase[];

defineSessionCases(sessionListCases);
