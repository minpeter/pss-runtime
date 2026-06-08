import type { AgentEvent } from "./session/events";
import type { UserInput } from "./session/input";
import { enqueueDurableBackgroundNotification } from "./subagent-background-notification-inbox";
import type {
  RuntimeInputSink,
  SubagentJob,
  SubagentJobGroup,
} from "./subagent-types";

export function registerBackgroundJobGroup({
  groupId,
  groups,
  job,
}: {
  readonly groupId: string | undefined;
  readonly groups: Map<string, SubagentJobGroup>;
  readonly job: SubagentJob;
}): void {
  if (!groupId) {
    return;
  }

  let group = groups.get(groupId);
  if (!group) {
    group = {
      completedEvents: [],
      failedNotifiedJobIds: new Set(),
      finalNotified: false,
      id: groupId,
      jobIds: new Set(),
    };
    groups.set(groupId, group);
  }
  group.jobIds.add(job.id);
}

export async function notifyBackgroundCompletion({
  endEvent,
  groups,
  job,
  jobs,
  parentSession,
}: {
  readonly endEvent: Extract<AgentEvent, { type: "subagent-job-end" }>;
  readonly groups: Map<string, SubagentJobGroup>;
  readonly job: SubagentJob;
  readonly jobs: Map<string, SubagentJob>;
  readonly parentSession: RuntimeInputSink;
}): Promise<void> {
  const group = job.groupId ? groups.get(job.groupId) : undefined;
  if (!group) {
    await notifyParentSession({
      input: buildBackgroundReminder([job]),
      jobs: [job],
      observerEvents: [endEvent],
      parentSession,
    });
    return;
  }

  group.completedEvents.push(endEvent);
  if (isFailureStatus(endEvent.status)) {
    group.failedNotifiedJobIds.add(job.id);
    await notifyParentSession({
      input: buildBackgroundReminder([job]),
      jobs: [job],
      observerEvents: [endEvent],
      parentSession,
    });
  }

  if (!isGroupSettled(group, jobs) || group.finalNotified) {
    return;
  }

  group.finalNotified = true;
  const groupJobs = [...group.jobIds]
    .map((id) => jobs.get(id))
    .filter(isDefinedJob);
  const notifyableGroupJobs = groupJobs.filter(
    (groupJob) => !group.failedNotifiedJobIds.has(groupJob.id)
  );
  if (notifyableGroupJobs.length === 0) {
    groups.delete(group.id);
    return;
  }
  const observerEvents = group.completedEvents.filter(
    (event) => !group.failedNotifiedJobIds.has(event.task_id ?? "")
  );
  await notifyParentSession({
    input: buildBackgroundReminder(notifyableGroupJobs),
    jobs: notifyableGroupJobs,
    observerEvents: [...observerEvents],
    parentSession,
  });
  groups.delete(group.id);
}

async function notifyParentSession({
  input,
  jobs,
  observerEvents,
  parentSession,
}: {
  readonly input: UserInput;
  readonly jobs: readonly SubagentJob[];
  readonly observerEvents: readonly AgentEvent[];
  readonly parentSession: RuntimeInputSink;
}): Promise<void> {
  try {
    const mode = await enqueueDurableBackgroundNotification({
      input,
      jobs,
      observerEvents,
    });
    if (mode === "queued-only") {
      return;
    }

    await Promise.all(
      observerEvents.map((event) => parentSession.emitObserverEvent(event))
    );
    await parentSession.notify(input, {
      deferWhenUnobserved: true,
      observerEvents,
    });
  } catch (error) {
    await parentSession.emitObserverEvent({
      message: errorMessage(error),
      type: "turn-error",
    });
  }
}

function buildBackgroundReminder(jobs: readonly SubagentJob[]): UserInput {
  const text =
    jobs.length === 1
      ? buildSingleJobReminder(jobs[0])
      : buildGroupReminder(jobs);
  return { text, type: "user-text" };
}

function buildSingleJobReminder(job: SubagentJob | undefined): string {
  if (!job) {
    return [
      "<system-reminder>",
      "[BACKGROUND TASK COMPLETED]",
      "[SUBAGENT JOB RESULT READY]",
      "A background task completed, but its task metadata is no longer available.",
      "</system-reminder>",
    ].join("\n");
  }

  return [
    "<system-reminder>",
    "[BACKGROUND TASK COMPLETED]",
    "[SUBAGENT JOB RESULT READY]",
    `Task ID: ${job.id}`,
    `Subagent: ${job.subagent}`,
    `Status: ${job.status}`,
    `Description: ${sanitizeReminderField(job.description ?? "")}`,
    `Use background_output({ task_id: "${job.id}" }) to retrieve the result.`,
    "</system-reminder>",
  ].join("\n");
}

function buildGroupReminder(jobs: readonly SubagentJob[]): string {
  return [
    "<system-reminder>",
    "[ALL BACKGROUND TASKS COMPLETE]",
    `Completed task count: ${jobs.length}`,
    "Tasks:",
    ...jobs.map(
      (job) =>
        `- ${job.id} (${job.subagent}): ${job.status}. Description: ${sanitizeReminderField(
          job.description ?? ""
        )}. Use background_output({ task_id: "${job.id}" }) to retrieve the result.`
    ),
    "</system-reminder>",
  ].join("\n");
}

function isGroupSettled(
  group: SubagentJobGroup,
  jobs: Map<string, SubagentJob>
): boolean {
  for (const id of group.jobIds) {
    const job = jobs.get(id);
    if (!job || isActiveJobStatus(job.status) || !job.settled) {
      return false;
    }
  }

  return true;
}

function isActiveJobStatus(status: SubagentJob["status"]): boolean {
  return status === "pending" || status === "running";
}

function isFailureStatus(
  status: Extract<AgentEvent, { type: "subagent-job-end" }>["status"]
): boolean {
  return status === "aborted" || status === "cancelled" || status === "error";
}

function isDefinedJob(job: SubagentJob | undefined): job is SubagentJob {
  return job !== undefined;
}

function sanitizeReminderField(value: string): string {
  return value
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
