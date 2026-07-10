import type { AgentPrepareStep } from "@minpeter/pss-runtime";
import { createToolIndex } from "toolpick";

import {
  LIST_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "./session-tools";
import { SEND_MESSAGE_TOOL_NAME, type WorkerAgentToolSet } from "./tools";

/** Env flag: `"1"` / `"true"` / `"yes"` enables hybrid toolpick prepareStep. */
export const TOOLPICK_ENABLED_ENV = "TOOLPICK_ENABLED";

/**
 * Always expose delivery — user-visible replies depend on send_message.
 * Session tools co-activate so list/search → read stays one selection page.
 */
export const WORKER_AGENT_TOOLPICK_ALWAYS_ACTIVE = [
  SEND_MESSAGE_TOOL_NAME,
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
};

export const WORKER_AGENT_TOOLPICK_MAX_TOOLS = 5;

export interface ToolpickSelectionMetric {
  readonly activeTools: readonly string[];
  readonly stepNumber: number;
}

export interface CreateWorkerAgentPrepareStepOptions {
  readonly maxTools?: number;
  /** Optional host metrics (wide-event / log) for each prepareStep selection. */
  readonly onSelect?: (metric: ToolpickSelectionMetric) => void;
}

export function isToolpickEnabled(env: {
  readonly TOOLPICK_ENABLED?: string;
}): boolean {
  const value = env.TOOLPICK_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Hybrid (keyword) toolpick index → AI SDK prepareStep for activeTools.
 *
 * Note: PSS outer-loop prepareStep usually sees stepNumber 0 / empty steps, so
 * toolpick miss-paging does not advance across PSS steps. Selection still
 * re-ranks from the current message context on every outer step.
 */
export function createWorkerAgentPrepareStep(
  tools: WorkerAgentToolSet,
  options: CreateWorkerAgentPrepareStepOptions = {}
): AgentPrepareStep {
  const maxTools = options.maxTools ?? WORKER_AGENT_TOOLPICK_MAX_TOOLS;
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
  const selectStep = index.prepareStep({
    alwaysActive: [...WORKER_AGENT_TOOLPICK_ALWAYS_ACTIVE],
    maxTools,
    relatedTools,
  });

  return async (stepOptions) => {
    const result = await selectStep(stepOptions);
    const activeTools = normalizeActiveToolNames(result?.activeTools);
    options.onSelect?.({
      activeTools,
      stepNumber: stepOptions.stepNumber,
    });
    return result;
  };
}

function normalizeActiveToolNames(activeTools: unknown): readonly string[] {
  if (!Array.isArray(activeTools)) {
    return [];
  }
  return activeTools.filter((name): name is string => typeof name === "string");
}
