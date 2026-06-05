import type { AgentEvent } from "./session/events";
import type { AgentInput } from "./session/input";
import type { AgentRun } from "./session/run";
import type {
  CompactSubagentResult,
  Subagent,
  SubagentRunResult,
} from "./subagent-types";

const maxCompactTextLength = 20_000;
const childSessionKeySuffixPattern = /^[A-Za-z0-9_-]{1,80}$/;

export async function runBlockingDelegation({
  prompt,
  sessionKey,
  subagent,
}: {
  readonly prompt: AgentInput;
  readonly sessionKey: string;
  readonly subagent: Subagent;
}): Promise<CompactSubagentResult> {
  return collectSubagentRun(
    await subagent.session(sessionKey).send(prompt),
    subagent.name ?? "subagent"
  );
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
  const text: string[] = [];

  for await (const event of run.events()) {
    eventCount += 1;
    events.push(event);
    onEvent?.(event);
    if (event.type === "assistant-text") {
      text.push(event.text);
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
          text: compactText(text),
        },
      };
    }
  }

  return {
    events,
    result: {
      eventCount,
      result,
      run_in_background: false,
      subagent,
      text: compactText(text),
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
