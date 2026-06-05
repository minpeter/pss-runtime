import { jsonSchema, tool } from "ai";
import { assertBackgroundTaskId, isActiveJob } from "./subagent-jobs";
import type { BackgroundOutputInput, SubagentJob } from "./subagent-types";

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

async function waitForJob(job: SubagentJob, timeout: number | undefined) {
  const timeoutMs = Math.min(timeout ?? 60_000, 600_000);
  await Promise.race([
    job.promise,
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
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
