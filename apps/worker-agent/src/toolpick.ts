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
 * Other tools are selected by hybrid ranking (or sticky/fallback).
 */
export const WORKER_AGENT_TOOLPICK_ALWAYS_ACTIVE = [
  SEND_MESSAGE_TOOL_NAME,
] as const;

export const WORKER_AGENT_SESSION_TOOL_NAMES = [
  LIST_SESSIONS_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
] as const;

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
  // Keep lightweight utilities from isolating each other when one ranks.
  [CALCULATE_TOOL_NAME]: [GET_CURRENT_TIME_TOOL_NAME],
  [GET_CURRENT_TIME_TOOL_NAME]: [CALCULATE_TOOL_NAME],
  [GET_WEATHER_TOOL_NAME]: [GET_CURRENT_TIME_TOOL_NAME],
};

/**
 * Search ceiling before alwaysActive + relatedTools expansion.
 * ~10 product tools: allow a small ranked set so chat stays lean.
 */
export const WORKER_AGENT_TOOLPICK_MAX_TOOLS = 3;

/** After this many no-tool outer steps in the open turn, expose the full set. */
export const WORKER_AGENT_TOOLPICK_MISS_FALLBACK = 2;

export type ToolpickSelectionReason =
  | "hybrid"
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
 * - Default path: only `send_message` (+ hybrid hits), so casual chat does not
 *   pay session-tool schema tokens or accidental recall calls.
 * - Sticky: after any session tool runs in the open turn, keep the session
 *   cluster active so list/search → read can continue across PSS outer steps.
 * - Miss fallback: after two no-tool outer steps, expose all tools (PSS does
 *   not advance AI SDK stepNumber, so we infer misses from message history).
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
    const query = extractQuery(messages, steps, stepNumber);
    const misses = countOuterToolMisses(messages);

    let reason: ToolpickSelectionReason = "hybrid";
    let activeTools: string[];

    if (misses >= WORKER_AGENT_TOOLPICK_MISS_FALLBACK) {
      reason = "miss-fallback";
      activeTools = uniqueNames([...toolNames, ...alwaysActive]);
    } else if (hasStickySessionTools(messages, sessionToolsPresent)) {
      reason = "sticky-session";
      activeTools = uniqueNames([...alwaysActive, ...sessionToolsPresent]);
    } else {
      const selected = query
        ? await index.select(query, {
            alwaysActive,
            maxTools,
            relatedTools,
          })
        : [...alwaysActive];
      activeTools = selected.filter((name) => toolNameSet.has(name));
      if (activeTools.length === 0) {
        activeTools = [...alwaysActive];
      }
    }

    options.onSelect?.({
      activeTools,
      query,
      reason,
      stepNumber,
    });

    return { activeTools };
  };
}

/** Exported for unit tests: consecutive no-tool assistant steps after last user. */
export function countOuterToolMisses(
  messages: readonly ModelMessage[]
): number {
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
    if (assistantHasToolCalls(message)) {
      misses = 0;
      continue;
    }
    if (assistantHasText(message)) {
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

function assistantHasToolCalls(message: ModelMessage): boolean {
  return assistantToolCallNames(message).length > 0;
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
