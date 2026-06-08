import { ownsAgentNamespace } from "./agent-namespace";
import { StoredAgentRun } from "./execution/run";
import type {
  ExecutionHost,
  NotificationRecord,
  RunRecord,
} from "./execution/types";
import { type AgentRun, BufferedAgentRun } from "./session/run";
import { readDurableBackgroundChildRunState } from "./subagent-background-child-run-state";
import { buildDurableResumeGroups } from "./subagent-background-resume-group";
import { runBackgroundJob } from "./subagent-background-runner";
import type { RuntimeInputSink, Subagent, SubagentJob } from "./subagent-types";

const defaultResumeLeaseMs = 300_000;

interface ResumeAgentRunInput {
  readonly host: ExecutionHost;
  readonly ownerNamespace: string;
  resumeNotification(notification: NotificationRecord): Promise<AgentRun>;
  readonly runId: string;
  readonly subagents: readonly Subagent[];
}

export async function resumeAgentRun({
  host,
  ownerNamespace,
  resumeNotification,
  runId,
  subagents,
}: ResumeAgentRunInput): Promise<AgentRun | null> {
  const run = await host.store.runs.get(runId);
  if (!run) {
    return null;
  }
  if (!canAccessRun(run, ownerNamespace)) {
    return null;
  }

  if (run.kind === "background-subagent") {
    return await resumeBackgroundSubagentRun({ host, run, subagents });
  }

  if (run.kind === "notification" && run.dedupeKey) {
    const idempotencyKey = run.dedupeKey;
    const claimed = await claimRun(host, run);
    if (!claimed) {
      return null;
    }

    const notification = await claimNotificationForRun({
      host,
      idempotencyKey,
      ownerNamespace,
    });
    if (!notification) {
      return null;
    }

    try {
      const notificationRun = await resumeNotification(notification);
      await completeNotificationRun(host, claimed.runId);
      return notificationRun;
    } catch (error) {
      await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
      throw error;
    }
  }

  return null;
}

async function claimNotificationForRun({
  host,
  idempotencyKey,
  ownerNamespace,
}: {
  readonly host: ExecutionHost;
  readonly idempotencyKey: string;
  readonly ownerNamespace: string;
}): Promise<NotificationRecord | null> {
  const current =
    await host.store.notifications.getByIdempotencyKey(idempotencyKey);
  if (!ownsAgentNamespace(current?.ownerNamespace, ownerNamespace)) {
    return null;
  }

  const claim =
    await host.store.notifications.claimByIdempotencyKey(idempotencyKey);
  if (claim.ok) {
    if (ownsAgentNamespace(claim.record.ownerNamespace, ownerNamespace)) {
      return claim.record;
    }
    await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
    return null;
  }

  if (
    claim.reason === "already-claimed" &&
    ownsAgentNamespace(claim.record?.ownerNamespace, ownerNamespace)
  ) {
    return claim.record ?? null;
  }

  return null;
}

function canAccessRun(run: RunRecord, ownerNamespace: string): boolean {
  if (run.ownerNamespace) {
    return ownsAgentNamespace(run.ownerNamespace, ownerNamespace);
  }

  return (
    run.sessionKey.startsWith(`parent:${ownerNamespace}:`) ||
    run.parentRunId?.startsWith(`${ownerNamespace}:session:`) === true
  );
}

export async function completeNotificationRun(
  host: ExecutionHost,
  runId: string
): Promise<void> {
  const run = await host.store.runs.get(runId);
  if (run?.kind !== "notification" || run.status === "completed") {
    return;
  }

  await host.store.runs.update({ ...run, status: "completed" });
}

async function resumeBackgroundSubagentRun({
  host,
  run,
  subagents,
}: {
  readonly host: ExecutionHost;
  readonly run: RunRecord;
  readonly subagents: readonly Subagent[];
}): Promise<AgentRun | null> {
  const claimed = await claimRun(host, run);
  if (!claimed) {
    return null;
  }

  const checkpoint = await host.store.checkpoints.latest(run.runId);
  const state = readDurableBackgroundChildRunState(checkpoint);
  if (!state) {
    throw new AgentResumeError(run.runId, "missing background run state");
  }

  const subagent = subagents.find(
    (candidate) => candidate.name === state.subagent
  );
  if (!subagent) {
    throw new AgentResumeError(
      run.runId,
      `missing subagent ${JSON.stringify(state.subagent)}`
    );
  }

  const childSession = subagent.session(claimed.sessionKey);
  const job: SubagentJob = {
    abort: () => childSession.interrupt(),
    childRunId: claimed.runId,
    childRunLeaseId: claimed.lease?.leaseId,
    cleanup: () => Promise.resolve(),
    dedupeKey: claimed.dedupeKey,
    delegateToolCallId: state.delegateToolCallId,
    description: state.description,
    executionHost: host,
    groupId: state.groupId,
    id: claimed.publicTaskId ?? claimed.runId,
    ownerNamespace: claimed.ownerNamespace,
    parentRunId: claimed.parentRunId,
    parentSessionKey: state.parentSessionKey,
    promise: Promise.resolve(),
    sessionKey: claimed.sessionKey,
    settled: false,
    status: "running",
    subagent: state.subagent,
  };
  const jobs = new Map([[job.id, job]]);
  const groups = await buildDurableResumeGroups({
    currentJob: job,
    host,
    run: claimed,
    state,
    jobs,
  });
  const parentSession = durableParentSession(host, run.runId);

  job.promise = runBackgroundJob({
    childSession,
    groups,
    jobs,
    job,
    parentSession,
    prompt: state.prompt,
  });
  await job.promise;

  return new StoredAgentRun({
    eventStore: host.store.events,
    runId: run.runId,
  });
}

async function claimRun(
  host: ExecutionHost,
  run: RunRecord
): Promise<RunRecord | null> {
  const claim = await host.store.runs.claim(run.runId, {
    attempt: (run.lease?.attempt ?? 0) + 1,
    leaseId: crypto.randomUUID(),
    leaseMs: defaultResumeLeaseMs,
    nowMs: Date.now(),
  });
  return claim.ok ? claim.record : null;
}

function durableParentSession(
  host: ExecutionHost,
  runId: string
): RuntimeInputSink {
  return {
    emitObserverEvent: (event) => host.store.events.append(runId, event).then(),
    enqueueRuntimeInput: () => undefined,
    notify: () => Promise.resolve(emptyRun()),
  };
}

function emptyRun(): AgentRun {
  const run = new BufferedAgentRun();
  run.close();
  return run;
}

class AgentResumeError extends Error {
  constructor(runId: string, reason: string) {
    super(`Cannot resume agent run ${runId}: ${reason}`);
    this.name = "AgentResumeError";
  }
}
