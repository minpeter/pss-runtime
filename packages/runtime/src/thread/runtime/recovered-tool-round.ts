import type { JSONValue, ModelMessage, ToolSet } from "ai";
import type {
  JournaledToolIntent,
  ToolRecoveryDecision,
} from "../../execution/host/tool-step-journal";
import { assertNever } from "../../internal/guards";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import { rerunToolCall } from "../../llm/tool-execution-wrapper";
import type { AgentEvent } from "../protocol/events";
import { modelMessageToAgentEvents } from "../protocol/mapping";
import type { ThreadState } from "../state/thread-state";
import { waitForCompactionQueue } from "./compaction-queue-deadline";
import type { ThreadExecutionRun } from "./execution";
import type { RecoveredToolOutcome } from "./execution-checkpoints";

/** Error text the model receives for a call that a crash or cancellation cut short. */
export const INTERRUPTED_TOOL_CALL_TEXT =
  "The tool call was interrupted before it finished and may have partly run. Check its effects before calling it again.";

/** A finished call of a recovered tool round. */
export interface RecoveredToolRoundCall {
  readonly input: unknown;
  readonly outcome: RecoveredToolOutcome;
  readonly toolCallId: string;
  readonly toolName: string;
}

/** The assistant tool calls and tool results of one recovered round. */
export function recoveredToolRoundMessages(
  calls: readonly RecoveredToolRoundCall[]
): ModelMessage[] {
  if (calls.length === 0) {
    return [];
  }
  return [
    {
      content: calls.map((call) => ({
        input: call.input ?? {},
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        type: "tool-call" as const,
      })),
      role: "assistant",
    },
    {
      content: calls.map((call) => ({
        output:
          "errorText" in call.outcome
            ? { type: "error-text" as const, value: call.outcome.errorText }
            : toolResultOutput(call.outcome.output),
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        type: "tool-result" as const,
      })),
      role: "tool",
    },
  ];
}

/**
 * Settles the unfinished calls of a crashed step before the recovered turn's
 * first model request: reruns `pure` and `idempotent` calls under their
 * idempotency keys, reports `interrupt` calls as interrupted, and applies
 * decisions recorded by `agent.resolveRecovery()`. Each outcome is journaled
 * before the round joins history and commits, so a crash in between neither
 * loses nor repeats it. A cancelled turn still adds the round: calls it cut
 * short are reported as interrupted, and the turn's terminal commit keeps it.
 */
export async function settleRecoveredToolCalls({
  calls,
  commitRound,
  emit,
  executionRun,
  signal,
  state,
  tools,
}: {
  readonly calls: readonly JournaledToolIntent[] | undefined;
  readonly commitRound: () => Promise<void>;
  readonly emit: (event: AgentEvent) => Promise<unknown>;
  readonly executionRun: ThreadExecutionRun | undefined;
  readonly signal: AbortSignal;
  readonly state: ThreadState;
  readonly tools: ToolSet | undefined;
}): Promise<"aborted" | "settled"> {
  if (!(calls?.length && executionRun)) {
    return "settled";
  }
  const { toolExecution } = executionRun;
  toolExecution.resumeToolCalls(calls);
  const settled: RecoveredToolRoundCall[] = [];
  for (const call of calls) {
    settled.push({
      input: call.input,
      outcome: signal.aborted
        ? { errorText: INTERRUPTED_TOOL_CALL_TEXT }
        : await settleCall(call),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
    });
  }

  const round = recoveredToolRoundMessages(settled);
  for (const message of round) {
    state.history.appendModelMessage(message);
  }
  for (const message of round) {
    for (const event of modelMessageToAgentEvents(message)) {
      await emit(event);
    }
  }
  if (signal.aborted) {
    return "aborted";
  }
  const finishToolRoundCommit = toolExecution.beginToolRoundCommit();
  await commitRound();
  finishToolRoundCommit?.();
  return "settled";

  async function settleCall(
    call: JournaledToolIntent
  ): Promise<RecoveredToolOutcome> {
    try {
      // A tool that ignores cancellation must not hold the turn open.
      return await waitForCompactionQueue(settleUncancelledCall(call), signal);
    } catch (error) {
      // A cancelled rerun may have partly run.
      if (signal.aborted) {
        return { errorText: INTERRUPTED_TOOL_CALL_TEXT };
      }
      throw error;
    }
  }

  async function settleUncancelledCall(
    call: JournaledToolIntent
  ): Promise<RecoveredToolOutcome> {
    const decision = recoveryDecision(call);
    if (decision.action === "rerun") {
      const rerun = await rerunToolCall({
        attempt: call.attempt + 1,
        input: call.input,
        messages: state.modelSnapshot(),
        signal,
        toolCallId: call.toolCallId,
        toolDefinition: tools?.[call.toolName],
        toolExecution,
        toolName: call.toolName,
      });
      if (rerun) {
        return rerun;
      }
    }
    const outcome: RecoveredToolOutcome =
      decision.action === "result"
        ? { output: decision.output }
        : {
            errorText:
              decision.action === "rerun"
                ? `Tool ${call.toolName} is unavailable, so the interrupted call could not run again. It may have partly run.`
                : INTERRUPTED_TOOL_CALL_TEXT,
          };
    await toolExecution.settleToolCall(call, outcome);
    return outcome;
  }
}

function recoveryDecision(call: JournaledToolIntent): ToolRecoveryDecision {
  if (call.resolution) {
    return call.resolution;
  }
  switch (call.policy) {
    case "idempotent":
    case "pure":
      return { action: "rerun" };
    case "interrupt":
      return { action: "interrupt" };
    case "manual-recovery":
      // Recovery parks these runs before a turn starts; never guess.
      throw new ToolExecutionNeedsRecoveryError(call);
    default:
      return assertNever(call.policy);
  }
}

function toolResultOutput(
  output: unknown
):
  | { readonly type: "json"; readonly value: JSONValue }
  | { readonly type: "text"; readonly value: string } {
  return typeof output === "string"
    ? { type: "text", value: output }
    : { type: "json", value: (output ?? null) as JSONValue };
}
