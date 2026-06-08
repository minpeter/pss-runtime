import type { AgentInput } from "./session/input";
import {
  childRunStatus,
  updateBackgroundRunStatus,
} from "./subagent-background-child-run";
import { notifyBackgroundCompletion } from "./subagent-background-notify";
import { emitBackgroundJobUpdate } from "./subagent-job-observer";
import { collectSubagentRunWithEvents } from "./subagent-run";
import type {
  RuntimeInputSink,
  Subagent,
  SubagentJob,
  SubagentJobGroup,
} from "./subagent-types";

type BackgroundChildSession = ReturnType<Subagent["session"]>;

const durableCancelPollMs = 250;

export async function runBackgroundJob({
  childSession,
  groups,
  jobs,
  job,
  parentSession,
  prompt,
}: {
  readonly childSession: BackgroundChildSession;
  readonly groups: Map<string, SubagentJobGroup>;
  readonly jobs: Map<string, SubagentJob>;
  readonly job: SubagentJob;
  readonly parentSession: RuntimeInputSink;
  readonly prompt: AgentInput;
}): Promise<void> {
  if (job.status === "cancelled") {
    return;
  }
  job.status = "running";
  if (await syncDurableCancellation(job, childSession)) {
    return;
  }

  const stopCancelWatcher = startDurableCancellationWatcher(job, childSession);
  try {
    const { result } = await collectSubagentRunWithEvents(
      await childSession.send(prompt),
      job.subagent,
      (event) => emitBackgroundJobUpdate(parentSession, job, event)
    );
    if (await syncDurableCancellation(job, childSession)) {
      return;
    }
    const previousResult = job.result;
    job.result = result;
    const updated = await updateBackgroundRunStatus(
      job,
      childRunStatus(result.result)
    );
    if (!updated) {
      job.result = previousResult;
      job.status = "cancelled";
      childSession.interrupt();
      return;
    }
    job.status = result.result;
  } catch (error) {
    if (await syncDurableCancellation(job, childSession)) {
      return;
    }
    const jobError = error instanceof Error ? error : new Error(String(error));
    const previousResult = job.result;
    job.result = {
      error: errorMessage(jobError),
      eventCount: 0,
      result: "error",
      run_in_background: false,
      subagent: job.subagent,
      text: "",
    };
    const updated = await updateBackgroundRunStatus(job, "error");
    if (!updated) {
      job.result = previousResult;
      job.status = "cancelled";
      childSession.interrupt();
      return;
    }
    job.status = "error";
  } finally {
    stopCancelWatcher();
  }

  if (await syncDurableCancellation(job, childSession)) {
    return;
  }

  job.settled = true;
  await notifyBackgroundCompletion({
    endEvent: {
      error: job.result?.error,
      eventCount: job.result?.eventCount ?? 0,
      delegateToolCallId: job.delegateToolCallId,
      status: job.result?.result ?? "error",
      subagent: job.subagent,
      task_id: job.id,
      type: "subagent-job-end",
    },
    groups,
    job,
    jobs,
    parentSession,
  });
}

function startDurableCancellationWatcher(
  job: SubagentJob,
  childSession: BackgroundChildSession
): () => void {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    await syncDurableCancellation(job, childSession);
    if (stopped || job.status === "cancelled") {
      return;
    }
    timeoutId = setTimeout(() => {
      queueCancelPoll(poll, job, childSession);
    }, durableCancelPollMs);
  };

  queueCancelPoll(poll, job, childSession);
  return () => {
    stopped = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };
}

function queueCancelPoll(
  poll: () => Promise<void>,
  job: SubagentJob,
  childSession: BackgroundChildSession
): void {
  poll().catch((error: unknown) => {
    job.status = "error";
    job.result = {
      error: errorMessage(error),
      eventCount: 0,
      result: "error",
      run_in_background: false,
      subagent: job.subagent,
      text: "",
    };
    childSession.interrupt();
  });
}

async function syncDurableCancellation(
  job: SubagentJob,
  childSession: BackgroundChildSession
): Promise<boolean> {
  if (job.status === "cancelled") {
    childSession.interrupt();
    return true;
  }
  if (!(job.executionHost && job.childRunId)) {
    return false;
  }

  const run = await job.executionHost.store.runs.get(job.childRunId);
  const leaseLost =
    job.childRunLeaseId && run?.lease?.leaseId !== job.childRunLeaseId;
  if (run?.status !== "cancelled" && !leaseLost) {
    return false;
  }

  job.status = "cancelled";
  childSession.interrupt();
  return true;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
