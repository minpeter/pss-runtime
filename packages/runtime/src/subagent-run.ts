import type { AgentInput } from "./session/input";
import type { AgentRun } from "./session/run";
import type { CompactSubagentResult, Subagent } from "./subagent-types";

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
  let eventCount = 0;
  let result: CompactSubagentResult["result"] = "completed";
  const text: string[] = [];

  for await (const event of run.events()) {
    eventCount += 1;
    if (event.type === "assistant-text") {
      text.push(event.text);
    } else if (event.type === "turn-abort") {
      result = "aborted";
    } else if (event.type === "turn-error") {
      return {
        error: event.message,
        eventCount,
        result: "error",
        run_in_background: false,
        subagent,
        text: text.join(""),
      };
    }
  }

  return {
    eventCount,
    result,
    run_in_background: false,
    subagent,
    text: text.join(""),
  };
}

export function defaultChildSessionKey(
  parentSessionKey: string,
  subagent: string
): string {
  return `parent:${parentSessionKey}:subagent:${subagent}`;
}
