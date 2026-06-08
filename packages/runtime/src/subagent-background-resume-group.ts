import type { ExecutionHost, RunRecord } from "./execution/types";
import type { AgentEvent } from "./session/events";
import type { DurableBackgroundChildRunState } from "./subagent-background-child-run-state";
import { readDurableBackgroundChildRunState } from "./subagent-background-child-run-state";
import { backgroundRunJobStatus, isActiveJob } from "./subagent-job-state";
import type {
  CompactSubagentResult,
  SubagentJob,
  SubagentJobGroup,
} from "./subagent-types";

export async function buildDurableResumeGroups({
  currentJob,
  host,
  jobs,
  run,
  state,
}: {
  readonly currentJob: SubagentJob;
  readonly host: ExecutionHost;
  readonly jobs: Map<string, SubagentJob>;
  readonly run: RunRecord;
  readonly state: DurableBackgroundChildRunState;
}): Promise<Map<string, SubagentJobGroup>> {
  const groups = new Map<string, SubagentJobGroup>();
  if (!(state.groupId && run.parentRunId)) {
    return groups;
  }

  const group: SubagentJobGroup = {
    completedEvents: [],
    failedNotifiedJobIds: new Set(),
    finalNotified: false,
    id: state.groupId,
    jobIds: new Set(),
  };
  groups.set(group.id, group);

  for (const sibling of await host.store.runs.listByParentRunId(
    run.parentRunId
  )) {
    await addSiblingToGroup({
      currentJob,
      group,
      host,
      jobs,
      run,
      sibling,
      state,
    });
  }

  return groups;
}

async function addSiblingToGroup({
  currentJob,
  group,
  host,
  jobs,
  run,
  sibling,
  state,
}: {
  readonly currentJob: SubagentJob;
  readonly group: SubagentJobGroup;
  readonly host: ExecutionHost;
  readonly jobs: Map<string, SubagentJob>;
  readonly run: RunRecord;
  readonly sibling: RunRecord;
  readonly state: DurableBackgroundChildRunState;
}): Promise<void> {
  if (sibling.kind !== "background-subagent") {
    return;
  }

  const siblingState = readDurableBackgroundChildRunState(
    await host.store.checkpoints.latest(sibling.runId)
  );
  if (!siblingState || siblingState.groupId !== state.groupId) {
    return;
  }

  const siblingJob =
    sibling.runId === run.runId
      ? currentJob
      : durableSiblingJob({ host, run: sibling, state: siblingState });
  jobs.set(siblingJob.id, siblingJob);
  group.jobIds.add(siblingJob.id);

  const endEvent = durableTerminalEvent(siblingJob, sibling.output);
  if (!endEvent || sibling.runId === run.runId) {
    return;
  }
  group.completedEvents.push(endEvent);
  if (endEvent.status === "aborted" || endEvent.status === "error") {
    group.failedNotifiedJobIds.add(siblingJob.id);
  }
}

function durableSiblingJob({
  host,
  run,
  state,
}: {
  readonly host: ExecutionHost;
  readonly run: RunRecord;
  readonly state: DurableBackgroundChildRunState;
}): SubagentJob {
  const status = backgroundRunJobStatus(run.status) ?? "pending";
  const compactResult = compactSubagentResult(run.output);
  return {
    abort: () => undefined,
    childRunId: run.runId,
    cleanup: () => Promise.resolve(),
    dedupeKey: run.dedupeKey,
    delegateToolCallId: state.delegateToolCallId,
    description: state.description,
    executionHost: host,
    groupId: state.groupId,
    id: run.publicTaskId ?? run.runId,
    parentRunId: run.parentRunId,
    parentSessionKey: state.parentSessionKey,
    promise: Promise.resolve(),
    result: compactResult,
    sessionKey: run.sessionKey,
    settled: !isActiveJob(status),
    status,
    subagent: state.subagent,
  };
}

function durableTerminalEvent(
  job: SubagentJob,
  output: unknown
): Extract<AgentEvent, { type: "subagent-job-end" }> | null {
  if (job.status !== "completed" && job.status !== "cancelled") {
    return null;
  }

  const result = compactSubagentResult(output);
  return {
    error: result?.error,
    eventCount: result?.eventCount ?? 0,
    delegateToolCallId: job.delegateToolCallId,
    status: job.status,
    subagent: job.subagent,
    task_id: job.id,
    type: "subagent-job-end",
  };
}

function compactSubagentResult(
  output: unknown
): CompactSubagentResult | undefined {
  if (!isRecord(output)) {
    return;
  }

  if (
    typeof output.eventCount !== "number" ||
    output.run_in_background !== false ||
    typeof output.subagent !== "string" ||
    typeof output.text !== "string" ||
    !isCompactResultStatus(output.result)
  ) {
    return;
  }

  return {
    ...(typeof output.error === "string" ? { error: output.error } : {}),
    eventCount: output.eventCount,
    result: output.result,
    run_in_background: false,
    subagent: output.subagent,
    text: output.text,
  };
}

function isCompactResultStatus(
  value: unknown
): value is CompactSubagentResult["result"] {
  return value === "aborted" || value === "completed" || value === "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
