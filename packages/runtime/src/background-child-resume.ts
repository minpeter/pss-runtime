import { StoredAgentRun } from "./execution/run";
import type { ExecutionHost, RunRecord } from "./execution/types";
import type { AgentInput } from "./session/input";
import { type AgentRun, BufferedAgentRun } from "./session/run";
import { readDurableBackgroundChildRunState } from "./subagent-background-child-run-state";
import { buildDurableResumeGroups } from "./subagent-background-resume-group";
import { runBackgroundJob } from "./subagent-background-runner";
import type { RuntimeInputSink, SubagentJob } from "./subagent-types";

const defaultResumeLeaseMs = 300_000;

export interface BackgroundChildAgent {
  session(key: string): {
    delete(): Promise<void>;
    interrupt(): void;
    send(input: AgentInput): Promise<AgentRun>;
  };
}

export async function resumeBackgroundChildRun({
  childAgent,
  host,
  run,
}: {
  readonly childAgent: BackgroundChildAgent;
  readonly host: ExecutionHost;
  readonly run: RunRecord;
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

  const childSession = childAgent.session(claimed.sessionKey);
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
  }).finally(() => {
    job.settled = true;
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
