import type { AgentPrepareStep } from "@minpeter/pss-runtime";
import type { ModelMessage } from "ai";
import { createToolIndex, extractQuery } from "toolpick";

import {
  LIST_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "./session-tools";
import { SEND_MESSAGE_TOOL_NAME, type WorkerAgentToolSet } from "./tools";
import {
  CALCULATE_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
} from "./utility-tools";
import { GET_WEATHER_TOOL_NAME } from "./weather-tools";
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "./web-tools";

/**
 * Always expose delivery — user-visible replies depend on send_message.
 * Other tools are selected by hybrid ranking, intent boost, sticky, or fallback.
 */
export const WORKER_AGENT_TOOLPICK_ALWAYS_ACTIVE = [
  SEND_MESSAGE_TOOL_NAME,
] as const;

export const WORKER_AGENT_SESSION_TOOL_NAMES = [
  LIST_SESSIONS_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
] as const;

/** Delivery-only tool calls do not clear miss-fallback (model still "missed" info tools). */
export const WORKER_AGENT_TOOLPICK_IGNORE_FOR_MISS = [
  SEND_MESSAGE_TOOL_NAME,
] as const;

/**
 * Explicit KO/EN intent → tools. Hybrid keyword search is English-biased; this
 * covers short chat intents like "검색해줘" that otherwise leave only send_message.
 */
export const WORKER_AGENT_INTENT_TOOL_PATTERNS: readonly {
  readonly patterns: readonly RegExp[];
  readonly tools: readonly string[];
}[] = [
  {
    patterns: [
      /검색/u,
      /서치/u,
      /찾아/u,
      /알아봐/u,
      /look\s*up/iu,
      /\bsearch\b/iu,
      /\bgoogle\b/iu,
      /\bweb\b/iu,
      /뉴스/u,
      /\bnews\b/iu,
      /인터넷/u,
    ],
    tools: [WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME],
  },
  {
    patterns: [
      /페이지/u,
      /읽어/u,
      /\bfetch\b/iu,
      /\bscrape\b/iu,
      /https?:\/\//iu,
      /url/iu,
      /링크/u,
    ],
    tools: [WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME],
  },
  {
    patterns: [
      /날씨/u,
      /기온/u,
      /비\s*와/u,
      /\bweather\b/iu,
      /\bforecast\b/iu,
      /\btemperature\b/iu,
    ],
    tools: [GET_WEATHER_TOOL_NAME, GET_CURRENT_TIME_TOOL_NAME],
  },
  {
    patterns: [
      /몇\s*시/u,
      /시간/u,
      /지금/u,
      /\btime\b/iu,
      /\btimezone\b/iu,
      /시계/u,
    ],
    tools: [GET_CURRENT_TIME_TOOL_NAME],
  },
  {
    patterns: [
      /계산/u,
      /더하/u,
      /나눠/u,
      /곱하/u,
      /\bcalc/iu,
      /\bmath\b/iu,
      /[\d.]+\s*[+\-*/^%]/u,
    ],
    tools: [CALCULATE_TOOL_NAME],
  },
  {
    patterns: [
      /지난\s*대화/u,
      /이전\s*채팅/u,
      /예전에/u,
      /기억/u,
      /회상/u,
      /\bsession\b/iu,
      /\brecall\b/iu,
      /다른\s*대화/u,
    ],
    tools: [
      LIST_SESSIONS_TOOL_NAME,
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
    ],
  },
];

export const WORKER_AGENT_TOOLPICK_RELATED_TOOLS: Readonly<
  Record<string, readonly string[]>
> = {
  [LIST_SESSIONS_TOOL_NAME]: [
    SEARCH_SESSIONS_TOOL_NAME,
    READ_SESSION_TOOL_NAME,
  ],
  [READ_SESSION_TOOL_NAME]: [
    LIST_SESSIONS_TOOL_NAME,
    SEARCH_SESSIONS_TOOL_NAME,
  ],
  [SEARCH_SESSIONS_TOOL_NAME]: [
    LIST_SESSIONS_TOOL_NAME,
    READ_SESSION_TOOL_NAME,
  ],
  [WEB_SEARCH_TOOL_NAME]: [WEB_FETCH_TOOL_NAME],
  [WEB_FETCH_TOOL_NAME]: [WEB_SEARCH_TOOL_NAME],
  [CALCULATE_TOOL_NAME]: [GET_CURRENT_TIME_TOOL_NAME],
  [GET_CURRENT_TIME_TOOL_NAME]: [CALCULATE_TOOL_NAME],
  [GET_WEATHER_TOOL_NAME]: [GET_CURRENT_TIME_TOOL_NAME],
};

/**
 * Search ceiling before alwaysActive + relatedTools + intent expansion.
 */
export const WORKER_AGENT_TOOLPICK_MAX_TOOLS = 4;

/** After this many delivery-only / no-info-tool outer steps, expose the full set. */
export const WORKER_AGENT_TOOLPICK_MISS_FALLBACK = 2;

export type ToolpickSelectionReason =
  | "hybrid"
  | "intent"
  | "miss-fallback"
  | "sticky-session";

export interface ToolpickSelectionMetric {
  readonly activeTools: readonly string[];
  readonly query: string;
  readonly reason: ToolpickSelectionReason;
  readonly stepNumber: number;
}

export interface CreateWorkerAgentPrepareStepOptions {
  readonly maxTools?: number;
  /** Optional host metrics (wide-event / log) for each prepareStep selection. */
  readonly onSelect?: (metric: ToolpickSelectionMetric) => void;
}

/**
 * Hybrid toolpick prepareStep tuned for the worker-agent tool surface.
 *
 * - Intent patterns boost KO/EN chat phrases hybrid often misses.
 * - Delivery-only send_message steps count toward miss-fallback.
 * - Sticky keeps session tools after a session tool runs in the open turn.
 */
export function createWorkerAgentPrepareStep(
  tools: WorkerAgentToolSet,
  options: CreateWorkerAgentPrepareStepOptions = {}
): AgentPrepareStep {
  const maxTools = options.maxTools ?? WORKER_AGENT_TOOLPICK_MAX_TOOLS;
  const toolNames = Object.keys(tools);
  const toolNameSet = new Set(toolNames);
  const relatedTools = Object.fromEntries(
    Object.entries(WORKER_AGENT_TOOLPICK_RELATED_TOOLS).map(([key, value]) => [
      key,
      [...value],
    ])
  );
  const index = createToolIndex(tools, {
    relatedTools,
    strategy: "hybrid",
  });
  const alwaysActive = WORKER_AGENT_TOOLPICK_ALWAYS_ACTIVE.filter((name) =>
    toolNameSet.has(name)
  );
  const sessionToolsPresent = WORKER_AGENT_SESSION_TOOL_NAMES.filter((name) =>
    toolNameSet.has(name)
  );

  return async (stepOptions) => {
    const { messages, stepNumber, steps } = stepOptions;
    // Full conversation query (anchor+recent) for hybrid ranking.
    const query = extractQuery(messages, steps, stepNumber);
    // Intent must use only the latest user text — otherwise old "검색해줘"
    // anchors keep web tools active for later "야" / "응" turns.
    const latestUserText = latestUserMessageText(messages);
    const misses = countOuterToolMisses(messages);

    let reason: ToolpickSelectionReason = "hybrid";
    let activeTools: string[];

    if (misses >= WORKER_AGENT_TOOLPICK_MISS_FALLBACK) {
      reason = "miss-fallback";
      activeTools = uniqueNames([...toolNames, ...alwaysActive]);
    } else if (hasStickySessionTools(messages, sessionToolsPresent)) {
      reason = "sticky-session";
      activeTools = uniqueNames([...alwaysActive, ...sessionToolsPresent]);
    } else if (isCasualChitchat(latestUserText)) {
      // Short ack/greeting — do not inherit prior search/weather tool sets.
      reason = "hybrid";
      activeTools = [...alwaysActive];
    } else {
      const hybridSelected = query
        ? await index.select(query, {
            alwaysActive,
            maxTools,
            relatedTools,
          })
        : [...alwaysActive];
      const intentTools = intentToolsForQuery(latestUserText).filter((name) =>
        toolNameSet.has(name)
      );
      activeTools = uniqueNames([
        ...hybridSelected.filter((name) => toolNameSet.has(name)),
        ...intentTools,
        ...alwaysActive,
      ]);
      if (intentTools.length > 0) {
        reason = "intent";
      }
      if (activeTools.length === 0) {
        activeTools = [...alwaysActive];
      }
    }

    options.onSelect?.({
      activeTools,
      query: latestUserText || query,
      reason,
      stepNumber,
    });

    return { activeTools };
  };
}

/** Match KO/EN chat intents to product tools present in the catalog. */
export function intentToolsForQuery(query: string): string[] {
  const text = query.trim();
  if (!text) {
    return [];
  }
  const selected: string[] = [];
  for (const entry of WORKER_AGENT_INTENT_TOOL_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      selected.push(...entry.tools);
    }
  }
  return uniqueNames(selected);
}

/** Latest user text only (ignores older search anchors). */
export function latestUserMessageText(
  messages: readonly ModelMessage[]
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    return modelMessageText(message);
  }
  return "";
}

function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join(" ")
    .trim();
}

/**
 * Short greetings/acks that should not re-open web/session tools from history.
 * "야", "응", "ㅎㅎ", "ok" etc.
 */
export function isCasualChitchat(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  if (intentToolsForQuery(trimmed).length > 0) {
    return false;
  }
  if (trimmed.length <= 6) {
    return CASUAL_CHITCHAT_PATTERN.test(trimmed);
  }
  return false;
}

const CASUAL_CHITCHAT_PATTERN =
  /^(?:ㅎ+|ㅋ+|ㅇㅋ|ㅇㅇ|ㄱㄱ|야+|응+|어+|헐|와+|네+|넹|웅|음+|아+|오+|예|yes|yep|ok|okay|hey|hi|hello|yo)[\s!?.~…]*$/iu;

/**
 * Consecutive outer steps after the last user message that did not call any
 * non-delivery tool. send_message-only steps count as misses so miss-fallback
 * still works when the model keeps chatting without web/session tools.
 */
export function countOuterToolMisses(
  messages: readonly ModelMessage[],
  ignoreToolNames: readonly string[] = WORKER_AGENT_TOOLPICK_IGNORE_FOR_MISS
): number {
  const ignore = new Set(ignoreToolNames);
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) {
    return 0;
  }

  let misses = 0;
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const toolNames = assistantToolCallNames(message);
    const informative = toolNames.filter((name) => !ignore.has(name));
    if (informative.length > 0) {
      misses = 0;
      continue;
    }
    if (toolNames.length > 0 || assistantHasText(message)) {
      misses += 1;
    }
  }
  return misses;
}

/** Exported for unit tests: session tool used since the latest user message. */
export function hasStickySessionTools(
  messages: readonly ModelMessage[],
  sessionTools: readonly string[] = WORKER_AGENT_SESSION_TOOL_NAMES
): boolean {
  if (sessionTools.length === 0) {
    return false;
  }
  const sessionSet = new Set(sessionTools);
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) {
    return false;
  }

  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    for (const name of assistantToolCallNames(message)) {
      if (sessionSet.has(name)) {
        return true;
      }
    }
  }
  return false;
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function assistantToolCallNames(message: ModelMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  const names: string[] = [];
  for (const part of message.content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "tool-call" &&
      "toolName" in part &&
      typeof part.toolName === "string"
    ) {
      names.push(part.toolName);
    }
  }
  return names;
}

function assistantHasText(message: ModelMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
  );
}
