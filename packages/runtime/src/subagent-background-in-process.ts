import type { ExecutionHost, RunRecord } from "./execution/types";
import type { AgentInput } from "./session/input";
import { cancelBackgroundChildRun } from "./subagent-background-child-run";
import { registerBackgroundJobGroup } from "./subagent-background-notify";
import { runBackgroundJob } from "./subagent-background-runner";
import {
  backgroundCancelledLaunchOutput,
  backgroundLaunchOutput,
  backgroundReplayOutput,
  backgroundRunJobStatus,
} from "./subagent-job-state";
import type {
  RuntimeInputSink,
  Subagent,
  SubagentJob,
  SubagentJobGroup,
} from "./subagent-types";

export async function startInProcessBackgroundJob({
  abortSignal,
  childRun,
  delegateToolCallId,
  description,
  executionHost,
  groupId,
  groups,
  id,
  jobs,
  parentRunId,
  parentSession,
  parentSessionKey,
  ownerNamespace,
  prompt,
  registerCleanup,
  sessionKey,
  subagent,
}: {
  readonly abortSignal: AbortSignal;
  readonly childRun?: RunRecord;
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly executionHost?: ExecutionHost;
  readonly groupId?: string;
  readonly groups: Map<string, SubagentJobGroup>;
  readonly id: string;
  readonly jobs: Map<string, SubagentJob>;
  readonly parentRunId?: string;
  readonly parentSession: RuntimeInputSink;
  readonly parentSessionKey?: string;
  readonly ownerNamespace?: string;
  readonly prompt: AgentInput;
  readonly registerCleanup: (cleanup: () => Promise<void>) => () => void;
  readonly sessionKey: string;
  readonly subagent: Subagent;
}) {
  const subagentName = subagent.name ?? "subagent";
  const claimedChildRun = childRun
    ? await claimBackgroundChildRun({
        executionHost,
        run: childRun,
        subagent: subagentName,
      })
    : undefined;
  if (claimedChildRun?.replay) {
    return claimedChildRun.replay;
  }
  if (abortSignal.aborted) {
    if (executionHost && claimedChildRun?.run) {
      await cancelBackgroundChildRun({
        executionHost,
        runId: claimedChildRun.run.runId,
      });
    }
    return backgroundCancelledLaunchOutput({ id, subagent: subagent.name });
  }

  const childSessionKey =
    claimedChildRun?.run.sessionKey ?? `${sessionKey}:task:${id}`;
  const childSession = subagent.session(childSessionKey);
  const abort = () => childSession.interrupt();
  abortSignal.addEventListener("abort", abort, { once: true });
  const cleanup = () => childSession.delete();
  const unregisterCleanup = registerCleanup(cleanup);
  const job: SubagentJob = {
    abort,
    childRunId: claimedChildRun?.run.runId,
    childRunLeaseId: claimedChildRun?.run.lease?.leaseId,
    cleanup,
    dedupeKey: claimedChildRun?.run.dedupeKey,
    description,
    id,
    delegateToolCallId,
    executionHost,
    ownerNamespace,
    parentSessionKey,
    parentRunId,
    promise: Promise.resolve(),
    groupId,
    sessionKey: childSessionKey,
    settled: false,
    status: "pending",
    subagent: subagentName,
    unregisterCleanup,
  };
  jobs.set(id, job);
  registerBackgroundJobGroup({ groupId, groups, job });
  await parentSession.emitObserverEvent({
    description,
    delegateToolCallId,
    run_in_background: true,
    subagent: subagentName,
    task_id: id,
    type: "subagent-job-start",
  });
  job.status = "running";
  job.promise = runBackgroundJob({
    childSession,
    groups,
    jobs,
    job,
    parentSession,
    prompt,
  }).finally(() => {
    abortSignal.removeEventListener("abort", abort);
    job.settled = true;
  });

  return backgroundLaunchOutput(job);
}

async function claimBackgroundChildRun({
  executionHost,
  run,
  subagent,
}: {
  readonly executionHost: ExecutionHost | undefined;
  readonly run: RunRecord;
  readonly subagent: string;
}): Promise<
  | { readonly replay?: never; readonly run: RunRecord }
  | {
      readonly replay: ReturnType<typeof backgroundReplayOutput>;
      readonly run?: never;
    }
> {
  if (!executionHost) {
    return { run };
  }

  const claim = await executionHost.store.runs.claim(run.runId, {
    attempt: (run.lease?.attempt ?? 0) + 1,
    leaseId: crypto.randomUUID(),
    leaseMs: 300_000,
    nowMs: Date.now(),
  });
  if (claim.ok) {
    return { run: claim.record };
  }

  const latestRun = await executionHost.store.runs.get(run.runId);
  const status = backgroundRunJobStatus(latestRun?.status) ?? "pending";
  return {
    replay: backgroundReplayOutput({
      id: run.publicTaskId ?? run.runId,
      status,
      subagent,
    }),
  };
}
