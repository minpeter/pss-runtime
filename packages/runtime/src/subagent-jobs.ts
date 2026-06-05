import type { AgentEvent } from "./session/events";
import type { AgentInput } from "./session/input";
import { collectSubagentRunWithEvents } from "./subagent-run";
import type { RuntimeInputSink, Subagent, SubagentJob } from "./subagent-types";

const maxBackgroundJobs = 64;

export function startBackgroundJob({
  abortSignal,
  description,
  jobs,
  parentSession,
  prompt,
  sessionKey,
  subagent,
}: {
  readonly abortSignal: AbortSignal;
  readonly description?: string;
  readonly jobs: Map<string, SubagentJob>;
  readonly parentSession: RuntimeInputSink;
  readonly prompt: AgentInput;
  readonly sessionKey: string;
  readonly subagent: Subagent;
}) {
  const id = `bg_${crypto.randomUUID().replaceAll("-", "")}`;
  const childSessionKey = `${sessionKey}:task:${id}`;
  const childSession = subagent.session(childSessionKey);
  const abort = () => childSession.interrupt();
  abortSignal.addEventListener("abort", abort, { once: true });

  const job: SubagentJob = {
    abort,
    description,
    id,
    promise: Promise.resolve(),
    sessionKey: childSessionKey,
    status: "pending",
    subagent: subagent.name ?? "subagent",
  };
  job.promise = runBackgroundJob({
    childSession,
    job,
    parentSession,
    prompt,
  }).finally(() => {
    abortSignal.removeEventListener("abort", abort);
  });
  pruneJobs(jobs);
  jobs.set(id, job);
  parentSession.emitObserverEvent({
    description,
    run_in_background: true,
    sessionKey: childSessionKey,
    subagent: subagent.name ?? "subagent",
    task_id: id,
    type: "subagent-job-start",
  });

  return {
    message: `Background subagent job ${id} started. Use background_output({ task_id: "${id}" }) to retrieve the result.`,
    run_in_background: true,
    sessionKey: childSessionKey,
    status: job.status,
    subagent: subagent.name,
    task_id: id,
  };
}

async function runBackgroundJob({
  childSession,
  job,
  parentSession,
  prompt,
}: {
  readonly childSession: ReturnType<Subagent["session"]>;
  readonly job: SubagentJob;
  readonly parentSession: RuntimeInputSink;
  readonly prompt: AgentInput;
}): Promise<void> {
  if (job.status === "cancelled") {
    return;
  }

  job.status = "running";
  try {
    const { events, result } = await collectSubagentRunWithEvents(
      await childSession.send(prompt),
      job.subagent,
      (event) => emitJobUpdate(parentSession, job, event)
    );
    if (isCancelledJob(job)) {
      return;
    }
    job.events = events;
    job.result = result;
    job.status = result.result;
  } catch (error) {
    if (isCancelledJob(job)) {
      return;
    }
    job.status = "error";
    job.result = {
      error: errorMessage(error),
      eventCount: 0,
      result: "error",
      run_in_background: false,
      subagent: job.subagent,
      text: "",
    };
  }

  if (isCancelledJob(job)) {
    return;
  }

  parentSession.enqueueRuntimeInput(
    {
      text: [
        "<system-reminder>",
        "[SUBAGENT JOB RESULT READY]",
        `Task ID: ${job.id}`,
        `Subagent: ${job.subagent}`,
        `Description: ${sanitizeReminderField(job.description ?? "")}`,
        `Use background_output({ task_id: "${job.id}" }) to retrieve the result.`,
        "</system-reminder>",
      ].join("\n"),
      type: "user-text",
    },
    "turn-start"
  );
  parentSession.emitObserverEvent({
    error: job.result?.error,
    eventCount: job.result?.eventCount ?? 0,
    status: job.result?.result ?? "error",
    subagent: job.subagent,
    task_id: job.id,
    type: "subagent-job-end",
  });
}

function emitJobUpdate(
  parentSession: RuntimeInputSink,
  job: SubagentJob,
  event: AgentEvent
): void {
  const base = {
    eventType: event.type,
    status: job.status,
    subagent: job.subagent,
    task_id: job.id,
    type: "subagent-job-update" as const,
  };

  if (event.type === "assistant-text") {
    parentSession.emitObserverEvent({
      ...base,
      textPreview: event.text.slice(0, 200),
    });
    return;
  }

  parentSession.emitObserverEvent(base);
}

export function assertBackgroundTaskId(value: string): void {
  if (value.startsWith("bg_")) {
    return;
  }

  throw new Error(
    `background_output expects a background task_id starting with bg_, not a session key: ${value}`
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isActiveJob(status: SubagentJob["status"]): boolean {
  return status === "pending" || status === "running";
}

function isCancelledJob(job: SubagentJob): boolean {
  return job.status === "cancelled";
}

function pruneJobs(jobs: Map<string, SubagentJob>): void {
  while (jobs.size >= maxBackgroundJobs) {
    const oldest = jobs.keys().next().value as string | undefined;
    if (!oldest) {
      return;
    }

    const job = jobs.get(oldest);
    if (job && isActiveJob(job.status)) {
      cancelJob(job);
    }
    jobs.delete(oldest);
  }
}

export function cancelJob(job: SubagentJob): void {
  job.status = "cancelled";
  job.abort();
}

function sanitizeReminderField(value: string): string {
  return value
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
