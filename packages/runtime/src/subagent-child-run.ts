import type { ExecutionHost, RunRecord, RunStatus } from "./execution/types";
import type { AgentInput } from "./session/input";
import { runBlockingDelegation } from "./subagent-run";
import type { CompactSubagentResult, Subagent } from "./subagent-types";

export type BlockingSubagentRunCache = Map<
  string,
  Promise<CompactSubagentResult>
>;

export async function runBlockingChild({
  abortSignal,
  dedupeKey,
  executionHost,
  parentRunId,
  prompt,
  sessionKey,
  subagent,
}: {
  readonly abortSignal?: AbortSignal;
  readonly dedupeKey: string;
  readonly executionHost?: ExecutionHost;
  readonly parentRunId: string;
  readonly prompt: AgentInput;
  readonly sessionKey: string;
  readonly subagent: Subagent;
}): Promise<CompactSubagentResult> {
  const run = await getOrCreateBlockingChildRun({
    dedupeKey,
    executionHost,
    parentRunId,
    sessionKey,
  });
  const result = await runBlockingDelegation({
    abortSignal,
    prompt,
    sessionKey,
    subagent,
  });
  if (executionHost && run) {
    await executionHost.store.runs.update({
      ...run,
      checkpointVersion: run.checkpointVersion,
      status: childRunStatus(result.result),
    });
  }
  return result;
}

export function blockingSubagentDedupeKey(
  parentRunId: string,
  toolCallId: string | undefined
): string {
  return `blocking-subagent:${parentRunId}:${toolCallId ?? "unknown"}`;
}

async function getOrCreateBlockingChildRun({
  dedupeKey,
  executionHost,
  parentRunId,
  sessionKey,
}: {
  readonly dedupeKey: string;
  readonly executionHost?: ExecutionHost;
  readonly parentRunId: string;
  readonly sessionKey: string;
}): Promise<RunRecord | undefined> {
  if (!executionHost) {
    return;
  }

  const existing = await executionHost.store.runs.getByDedupeKey(dedupeKey);
  if (existing) {
    return existing;
  }

  const run: RunRecord = {
    checkpointVersion: 0,
    dedupeKey,
    kind: "subagent",
    parentRunId,
    rootRunId: parentRunId,
    runId: `child:${dedupeKey}`,
    sessionKey,
    status: "queued",
  };
  await executionHost.store.runs.create(run);
  await executionHost.store.checkpoints.append(
    {
      checkpointId: crypto.randomUUID(),
      phase: "before-child-run",
      runId: run.runId,
      runtimeState: {},
      sessionSnapshot: {},
      version: 1,
    },
    { expectedVersion: 0 }
  );
  await executionHost.store.checkpoints.append(
    {
      checkpointId: crypto.randomUUID(),
      childRunId: run.runId,
      phase: "child-linked",
      runId: run.runId,
      runtimeState: {},
      sessionSnapshot: {},
      version: 2,
    },
    { expectedVersion: 1 }
  );
  const linked = await executionHost.store.runs.get(run.runId);
  return linked ?? run;
}

function childRunStatus(
  result: CompactSubagentResult["result"]
): Extract<RunStatus, "cancelled" | "completed" | "error"> {
  if (result === "aborted") {
    return "cancelled";
  }

  if (result === "error") {
    return "error";
  }

  return "completed";
}
