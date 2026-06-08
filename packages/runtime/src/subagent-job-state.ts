import type { RunStatus } from "./execution/types";
import { updateBackgroundRunStatus } from "./subagent-background-child-run";
import type { SubagentJob } from "./subagent-types";

export function assertBackgroundTaskId(value: string, toolName: string): void {
  if (value.startsWith("bg_")) {
    return;
  }

  throw new Error(
    `${toolName} expects a background task_id starting with bg_, not a session key: ${value}`
  );
}

export function isActiveJob(status: SubagentJob["status"]): boolean {
  return status === "pending" || status === "running";
}

export function hasBackgroundJobCapacity({
  jobs,
  maxActiveJobs,
  maxRetainedJobs,
}: {
  readonly jobs: Map<string, SubagentJob>;
  readonly maxActiveJobs: number;
  readonly maxRetainedJobs: number;
}): boolean {
  if (jobs.size >= maxRetainedJobs) {
    return false;
  }

  let activeJobs = 0;
  for (const job of jobs.values()) {
    if (isActiveJob(job.status) || !job.settled) {
      activeJobs += 1;
    }
  }

  return activeJobs < maxActiveJobs;
}

export function cancelJob(job: SubagentJob): void {
  job.status = "cancelled";
  job.abort();
  const statusUpdate = updateBackgroundRunStatus(job, "cancelled");
  job.promise = Promise.allSettled([job.promise, statusUpdate]).then(
    () => undefined
  );
}

export async function cleanupJob(job: SubagentJob): Promise<void> {
  await job.cleanup();
  job.unregisterCleanup?.();
}

export function backgroundLaunchOutput(job: SubagentJob) {
  return {
    message: [
      `Background subagent job ${job.id} started.`,
      `Please wait for <system-reminder> before checking task ${job.id}.`,
      `Do NOT call background_output({ task_id: "${job.id}" }) now; wait for <system-reminder> first.`,
    ].join(" "),
    run_in_background: true,
    status: job.status,
    subagent: job.subagent,
    task_id: job.id,
  };
}

export function backgroundCancelledLaunchOutput({
  id,
  subagent,
}: {
  readonly id: string;
  readonly subagent?: string;
}) {
  return {
    message: `Background subagent job ${id} was cancelled before it started.`,
    run_in_background: true,
    status: "cancelled",
    subagent,
    task_id: id,
  };
}

export function backgroundRunJobStatus(
  status: RunStatus | undefined
): Exclude<SubagentJob["status"], "aborted"> | null {
  if (status === "cancelled" || status === "completed" || status === "error") {
    return status;
  }

  if (status === "leased" || status === "running") {
    return "running";
  }

  if (
    status === "needs-recovery" ||
    status === "queued" ||
    status === "suspended"
  ) {
    return "pending";
  }

  return null;
}

export function backgroundReplayOutput({
  id,
  status,
  subagent,
}: {
  readonly id: string;
  readonly status: Exclude<SubagentJob["status"], "aborted">;
  readonly subagent: string;
}) {
  return {
    message: `Background subagent job ${id} was already ${status}. Reuse the existing task_id instead of launching it again.`,
    run_in_background: true,
    status,
    subagent,
    task_id: id,
  };
}
