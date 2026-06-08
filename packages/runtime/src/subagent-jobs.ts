import type { ExecutionHost } from "./execution/types";
import type { AgentInput } from "./session/input";
import {
  createBackgroundTaskId,
  createDurableBackgroundTaskId,
  getBackgroundChildRun,
  getOrCreateBackgroundChildRun,
} from "./subagent-background-child-run";
import { startInProcessBackgroundJob } from "./subagent-background-in-process";
import { scheduleDurableBackgroundJob } from "./subagent-background-schedule";
import {
  backgroundCancelledLaunchOutput,
  backgroundLaunchOutput,
  backgroundReplayOutput,
  backgroundRunJobStatus,
  hasBackgroundJobCapacity,
} from "./subagent-job-state";
import type {
  RuntimeInputSink,
  Subagent,
  SubagentJob,
  SubagentJobGroup,
} from "./subagent-types";

const maxBackgroundJobs = 64;
const maxRetainedBackgroundJobs = maxBackgroundJobs * 4;

export async function startBackgroundJob({
  abortSignal,
  description,
  executionHost,
  jobs,
  groupId,
  groups = new Map<string, SubagentJobGroup>(),
  delegateToolCallId,
  parentSession,
  parentRunId,
  parentSessionKey,
  ownerNamespace,
  prompt,
  registerCleanup,
  sessionKey,
  subagent,
}: {
  readonly abortSignal: AbortSignal;
  readonly description?: string;
  readonly executionHost?: ExecutionHost;
  readonly jobs: Map<string, SubagentJob>;
  readonly groupId?: string;
  readonly groups?: Map<string, SubagentJobGroup>;
  readonly delegateToolCallId?: string;
  readonly parentSession: RuntimeInputSink;
  readonly parentRunId?: string;
  readonly parentSessionKey?: string;
  readonly ownerNamespace?: string;
  readonly prompt: AgentInput;
  readonly registerCleanup: (cleanup: () => Promise<void>) => () => void;
  readonly sessionKey: string;
  readonly subagent: Subagent;
}) {
  const existingChildRun = await getBackgroundChildRun({
    delegateToolCallId,
    executionHost,
    parentRunId,
    parentSessionKey,
    prompt,
    sessionKey,
  });
  const id =
    existingChildRun?.publicTaskId ??
    (executionHost
      ? await createDurableBackgroundTaskId({
          delegateToolCallId,
          prompt,
          sessionKey,
        })
      : createBackgroundTaskId());
  const existingJob = jobs.get(id);
  if (existingJob) {
    return backgroundLaunchOutput(existingJob);
  }
  const replayedStatus = backgroundRunJobStatus(existingChildRun?.status);
  if (existingChildRun?.publicTaskId && replayedStatus) {
    return backgroundReplayOutput({
      id: existingChildRun.publicTaskId,
      status: replayedStatus,
      subagent: subagent.name ?? "subagent",
    });
  }

  if (
    !hasBackgroundJobCapacity({
      jobs,
      maxActiveJobs: maxBackgroundJobs,
      maxRetainedJobs: maxRetainedBackgroundJobs,
    })
  ) {
    return {
      message:
        "Background subagent job was not started because the background job limit is full.",
      run_in_background: true,
      status: "cancelled",
      subagent: subagent.name,
      task_id: id,
    };
  }

  if (abortSignal.aborted) {
    return backgroundCancelledLaunchOutput({ id, subagent: subagent.name });
  }

  const childRun = executionHost
    ? (existingChildRun ??
      (await getOrCreateBackgroundChildRun({
        delegateToolCallId,
        description,
        executionHost,
        groupId,
        ownerNamespace,
        parentRunId,
        parentSessionKey,
        prompt,
        publicTaskId: id,
        sessionKey,
        subagent: subagent.name ?? "subagent",
      })))
    : undefined;
  if (
    executionHost?.capabilities.backgroundSubagents === "durable" &&
    childRun
  ) {
    const job = await scheduleDurableBackgroundJob({
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
      subagent: subagent.name ?? "subagent",
    });
    return backgroundLaunchOutput(job);
  }
  return await startInProcessBackgroundJob({
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
  });
}
