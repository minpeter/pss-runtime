import { jsonSchema, tool } from "ai";
import type { AgentEvent } from "./session/events";
import type { AgentInput } from "./session/input";
import { collectSubagentRunWithEvents } from "./subagent-run";
import type {
  BackgroundCancelInput,
  BackgroundOutputInput,
  RuntimeInputSink,
  Subagent,
  SubagentJob,
} from "./subagent-types";

const maxBackgroundJobs = 64;

export function createBackgroundOutputTool(jobs: Map<string, SubagentJob>) {
  return tool<BackgroundOutputInput, unknown, Record<string, unknown>>({
    description: "Retrieve compact output for a background subagent job.",
    execute: async (input: BackgroundOutputInput) => {
      assertBackgroundTaskId(input.task_id);
      const job = jobs.get(input.task_id);
      if (!job) {
        throw new Error(`Unknown background subagent task ${input.task_id}.`);
      }

      if (input.block === true && isActiveJob(job.status)) {
        await waitForJob(job, input.timeout);
      }

      const output = {
        result: job.result,
        sessionKey: job.sessionKey,
        status: job.status,
        subagent: job.subagent,
        task_id: job.id,
      };
      const response =
        input.full_session === true
          ? {
              ...output,
              events: filterFullSessionEvents(job.events ?? [], input),
            }
          : output;

      if (!isActiveJob(job.status)) {
        jobs.delete(job.id);
      }

      return response;
    },
    inputSchema: jsonSchema<BackgroundOutputInput>({
      additionalProperties: false,
      properties: {
        block: { type: "boolean" },
        full_session: { type: "boolean" },
        include_thinking: { type: "boolean" },
        include_tool_results: { type: "boolean" },
        message_limit: { minimum: 0, type: "number" },
        task_id: { type: "string" },
        thinking_max_chars: { minimum: 0, type: "number" },
        timeout: { minimum: 0, type: "number" },
      },
      required: ["task_id"],
      type: "object",
    }),
  });
}

export function createBackgroundCancelTool(jobs: Map<string, SubagentJob>) {
  return tool<BackgroundCancelInput, unknown, Record<string, unknown>>({
    description: "Cancel an active background subagent job.",
    execute: (input: BackgroundCancelInput) => {
      assertBackgroundTaskId(input.task_id);
      const job = jobs.get(input.task_id);
      if (!job) {
        throw new Error(`Unknown background subagent task ${input.task_id}.`);
      }

      if (isActiveJob(job.status)) {
        job.status = "cancelled";
        job.abort();
      }

      return {
        status: job.status,
        task_id: job.id,
      };
    },
    inputSchema: jsonSchema<BackgroundCancelInput>({
      additionalProperties: false,
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
      type: "object",
    }),
  });
}

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
  const childSessionKey = sessionKey;
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

async function waitForJob(job: SubagentJob, timeout: number | undefined) {
  const timeoutMs = Math.min(timeout ?? 60_000, 600_000);
  await Promise.race([
    job.promise,
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

function assertBackgroundTaskId(value: string): void {
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

function isActiveJob(status: SubagentJob["status"]): boolean {
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
      job.abort();
    }
    jobs.delete(oldest);
  }
}

function sanitizeReminderField(value: string): string {
  return value
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function filterFullSessionEvents(
  events: readonly NonNullable<SubagentJob["events"]>[number][],
  input: BackgroundOutputInput
) {
  let filtered = events;

  if (input.include_thinking !== true) {
    filtered = filtered.filter((event) => event.type !== "assistant-reasoning");
  }

  if (input.include_tool_results !== true) {
    filtered = filtered.filter((event) => event.type !== "tool-result");
  }

  filtered = filtered.map((event) => {
    if (
      event.type !== "assistant-reasoning" ||
      input.thinking_max_chars === undefined ||
      event.text.length <= input.thinking_max_chars
    ) {
      return event;
    }

    return {
      ...event,
      text: event.text.slice(0, input.thinking_max_chars),
    };
  });

  if (input.message_limit !== undefined) {
    return filtered.slice(-input.message_limit);
  }

  return filtered;
}
