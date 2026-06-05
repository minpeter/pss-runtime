import type { AgentEvent } from "./session/events";
import type { AgentInput } from "./session/input";
import type { AgentRun } from "./session/run";
import type {
  CompactSubagentResult,
  Subagent,
  SubagentRunResult,
} from "./subagent-types";

const maxCompactTextLength = 20_000;
const maxStoredEvents = 200;
const childSessionKeySuffixPattern = /^[A-Za-z0-9_-]{1,80}$/;

export async function runBlockingDelegation({
  abortSignal,
  prompt,
  sessionKey,
  subagent,
}: {
  readonly abortSignal?: AbortSignal;
  readonly prompt: AgentInput;
  readonly sessionKey: string;
  readonly subagent: Subagent;
}): Promise<CompactSubagentResult> {
  const childSession = subagent.session(sessionKey);
  if (abortSignal?.aborted) {
    return {
      eventCount: 0,
      result: "aborted",
      run_in_background: false,
      subagent: subagent.name ?? "subagent",
      text: "",
    };
  }

  const abort = () => childSession.interrupt();
  abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await collectSubagentRun(
      await childSession.send(prompt),
      subagent.name ?? "subagent"
    );
  } finally {
    abortSignal?.removeEventListener("abort", abort);
  }
}

export async function collectSubagentRun(
  run: AgentRun,
  subagent: string
): Promise<CompactSubagentResult> {
  return (await collectSubagentRunWithEvents(run, subagent)).result;
}

export async function collectSubagentRunWithEvents(
  run: AgentRun,
  subagent: string,
  onEvent?: (event: AgentEvent) => void
): Promise<SubagentRunResult> {
  let eventCount = 0;
  let result: CompactSubagentResult["result"] = "completed";
  const events: AgentEvent[] = [];
  const textParts: string[] = [];
  let textLength = 0;

  try {
    for await (const event of run.events()) {
      eventCount += 1;
      if (events.length < maxStoredEvents) {
        events.push(event);
      }
      onEvent?.(event);
      if (event.type === "assistant-text") {
        textLength = appendCompactText(textParts, textLength, event.text);
      } else if (event.type === "turn-abort") {
        result = "aborted";
      } else if (event.type === "turn-error") {
        return {
          events,
          result: {
            error: event.message,
            eventCount,
            result: "error",
            run_in_background: false,
            subagent,
            text: compactText(textParts),
          },
        };
      }
    }
  } catch (error) {
    return {
      events,
      result: {
        error: errorMessage(error),
        eventCount,
        result: "error",
        run_in_background: false,
        subagent,
        text: compactText(textParts),
      },
    };
  }

  return {
    events,
    result: {
      eventCount,
      result,
      run_in_background: false,
      subagent,
      text: compactText(textParts),
    },
  };
}

export function defaultChildSessionKey(
  parentSessionKey: string,
  subagent: string
): string {
  return `parent:${parentSessionKey}:subagent:${subagent}`;
}

export function scopedChildSessionKey({
  parentSessionKey,
  sessionKey,
  subagent,
}: {
  readonly parentSessionKey: string;
  readonly sessionKey?: string;
  readonly subagent: string;
}): string {
  const base = defaultChildSessionKey(parentSessionKey, subagent);
  if (!sessionKey) {
    return base;
  }

  if (!childSessionKeySuffixPattern.test(sessionKey)) {
    throw new Error(
      "delegate sessionKey must be a short alphanumeric child-session suffix"
    );
  }

  return `${base}:${sessionKey}`;
}

function compactText(parts: readonly string[]): string {
  const text = parts.join("");
  if (text.length <= maxCompactTextLength) {
    return text;
  }

  return `${text.slice(0, maxCompactTextLength)}…[truncated]`;
}

function appendCompactText(
  parts: string[],
  currentLength: number,
  next: string
): number {
  if (currentLength >= maxCompactTextLength) {
    return currentLength;
  }

  const remaining = maxCompactTextLength - currentLength;
  const chunk = next.length > remaining ? next.slice(0, remaining) : next;
  parts.push(chunk);
  return currentLength + chunk.length;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
