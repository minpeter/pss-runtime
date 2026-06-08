import type { ExecutionHost, RunRecord, RunStatus } from "./execution/types";
import type { AgentInput } from "./session/input";
import { durableBackgroundChildRunState } from "./subagent-background-child-run-state";
import type { SubagentJob } from "./subagent-types";

interface BackgroundChildRunInput {
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly executionHost?: ExecutionHost;
  readonly groupId?: string;
  readonly ownerNamespace?: string;
  readonly parentRunId?: string;
  readonly parentSessionKey?: string;
  readonly prompt: AgentInput;
  readonly publicTaskId?: string;
  readonly sessionKey: string;
  readonly subagent?: string;
}

export function createBackgroundTaskId(): string {
  return `bg_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function createDurableBackgroundTaskId({
  delegateToolCallId,
  prompt,
  sessionKey,
}: Pick<
  BackgroundChildRunInput,
  "delegateToolCallId" | "prompt" | "sessionKey"
>): Promise<string> {
  const digestInput = backgroundSubagentDedupeKey({
    delegateToolCallId,
    prompt,
    sessionKey,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(digestInput)
  );
  const bytes = [...new Uint8Array(digest.slice(0, 16))];
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `bg_${hex}`;
}

export async function getBackgroundChildRun({
  delegateToolCallId,
  executionHost,
  prompt,
  sessionKey,
}: BackgroundChildRunInput): Promise<RunRecord | undefined> {
  if (!executionHost) {
    return;
  }

  const dedupeKey = backgroundSubagentDedupeKey({
    delegateToolCallId,
    prompt,
    sessionKey,
  });
  return (
    (await executionHost.store.runs.getByDedupeKey(dedupeKey)) ?? undefined
  );
}

export async function getOrCreateBackgroundChildRun(
  input: BackgroundChildRunInput
): Promise<RunRecord | undefined> {
  if (!input.executionHost) {
    return;
  }

  const id = input.publicTaskId ?? createBackgroundTaskId();
  const dedupeKey = backgroundSubagentDedupeKey(input);
  return await input.executionHost.store.transaction(async (tx) => {
    const existing = await tx.runs.getByDedupeKey(dedupeKey);
    if (existing) {
      return existing;
    }

    const parentRunId =
      input.parentRunId ?? input.parentSessionKey ?? input.sessionKey;
    const runtimeState = durableBackgroundChildRunState(input);
    const run: RunRecord = {
      checkpointVersion: 0,
      dedupeKey,
      kind: "background-subagent",
      ...(input.ownerNamespace ? { ownerNamespace: input.ownerNamespace } : {}),
      parentRunId,
      publicTaskId: id,
      rootRunId: parentRunId,
      runId: `background:${id}`,
      sessionKey: `${input.sessionKey}:task:${id}`,
      status: "queued",
    };
    await tx.runs.create(run);
    await tx.checkpoints.append(
      {
        checkpointId: crypto.randomUUID(),
        phase: "before-child-run",
        runId: run.runId,
        runtimeState,
        sessionSnapshot: {},
        version: 1,
      },
      { expectedVersion: 0 }
    );
    await tx.checkpoints.append(
      {
        checkpointId: crypto.randomUUID(),
        childRunId: run.runId,
        phase: "child-linked",
        runId: run.runId,
        runtimeState,
        sessionSnapshot: {},
        version: 2,
      },
      { expectedVersion: 1 }
    );
    return (await tx.runs.get(run.runId)) ?? run;
  });
}

export async function updateBackgroundRunStatus(
  job: SubagentJob,
  status: Extract<RunStatus, "cancelled" | "completed" | "error">
): Promise<boolean> {
  if (!(job.executionHost && job.childRunId)) {
    return true;
  }

  return await job.executionHost.store.transaction(async (tx) => {
    const run = await tx.runs.get(job.childRunId ?? "");
    if (!run || isTerminalBackgroundRunStatus(run.status)) {
      return false;
    }
    if (job.childRunLeaseId && run.lease?.leaseId !== job.childRunLeaseId) {
      return false;
    }

    await tx.runs.update({
      ...run,
      output: job.result ?? run.output,
      status,
    });
    return true;
  });
}

export async function cancelBackgroundChildRun({
  executionHost,
  runId,
}: {
  readonly executionHost: ExecutionHost;
  readonly runId: string;
}): Promise<RunRecord | null> {
  return await executionHost.store.transaction(async (tx) => {
    const run = await tx.runs.get(runId);
    if (!run || isTerminalBackgroundRunStatus(run.status)) {
      return run;
    }

    return await tx.runs.update({ ...run, status: "cancelled" });
  });
}

export function childRunStatus(
  result: Exclude<SubagentJob["status"], "cancelled" | "pending" | "running">
): Extract<RunStatus, "cancelled" | "completed" | "error"> {
  if (result === "aborted") {
    return "cancelled";
  }

  return result;
}

function backgroundSubagentDedupeKey({
  delegateToolCallId,
  prompt,
  sessionKey,
}: {
  readonly delegateToolCallId?: string;
  readonly prompt: AgentInput;
  readonly sessionKey: string;
}): string {
  return `background-subagent:${sessionKey}:${delegateToolCallId ?? "unknown"}:${JSON.stringify(prompt)}`;
}

function isTerminalBackgroundRunStatus(status: RunStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "error";
}
