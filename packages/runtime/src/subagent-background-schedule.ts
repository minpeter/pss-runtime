import type { RunRecord } from "./execution/types";
import { registerBackgroundJobGroup } from "./subagent-background-notify";
import type {
  RuntimeInputSink,
  SubagentJob,
  SubagentJobGroup,
} from "./subagent-types";

export async function scheduleDurableBackgroundJob({
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
  subagent,
}: {
  readonly childRun: RunRecord;
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly executionHost: NonNullable<SubagentJob["executionHost"]>;
  readonly groupId?: string;
  readonly groups: Map<string, SubagentJobGroup>;
  readonly id: string;
  readonly jobs: Map<string, SubagentJob>;
  readonly parentRunId?: string;
  readonly parentSession: RuntimeInputSink;
  readonly parentSessionKey?: string;
  readonly ownerNamespace?: string;
  readonly subagent: string;
}): Promise<SubagentJob> {
  const job: SubagentJob = {
    abort: () => undefined,
    childRunId: childRun.runId,
    cleanup: () => Promise.resolve(),
    dedupeKey: childRun.dedupeKey,
    description,
    id,
    delegateToolCallId,
    executionHost,
    ownerNamespace,
    parentSessionKey,
    parentRunId,
    promise: Promise.resolve(),
    groupId,
    sessionKey: childRun.sessionKey,
    settled: true,
    status: "pending",
    subagent,
  };
  jobs.set(id, job);
  registerBackgroundJobGroup({ groupId, groups, job });
  await parentSession.emitObserverEvent({
    description,
    delegateToolCallId,
    run_in_background: true,
    subagent,
    task_id: id,
    type: "subagent-job-start",
  });
  await executionHost.scheduler.enqueueRun(childRun.runId);
  return job;
}
