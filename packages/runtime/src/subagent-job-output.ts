import { jsonSchema, tool } from "ai";
import {
  assertBackgroundTaskId,
  cleanupJob,
  isActiveJob,
} from "./subagent-jobs";
import type { BackgroundOutputInput, SubagentJob } from "./subagent-types";

export function createBackgroundOutputTool(jobs: Map<string, SubagentJob>) {
  return tool<BackgroundOutputInput, unknown, Record<string, unknown>>({
    description: "Retrieve compact output for a background subagent job.",
    execute: async (input: BackgroundOutputInput, { abortSignal }) => {
      assertBackgroundTaskId(input.task_id, "background_output");
      const job = jobs.get(input.task_id);
      if (!job) {
        throw new Error(`Unknown background subagent task ${input.task_id}.`);
      }

      if (input.block === true && isActiveJob(job.status)) {
        await waitForJob(job, input.timeout, abortSignal);
      }

      const output = {
        result: job.result,
        status: job.status,
        subagent: job.subagent,
        task_id: job.id,
      };
      if (!isActiveJob(job.status)) {
        const cleaned = await cleanupJob(job).then(
          () => true,
          () => false
        );
        if (cleaned) {
          jobs.delete(job.id);
        }
      }

      return output;
    },
    inputSchema: jsonSchema<BackgroundOutputInput>({
      additionalProperties: false,
      properties: {
        block: { type: "boolean" },
        task_id: { type: "string" },
        timeout: { minimum: 0, type: "number" },
      },
      required: ["task_id"],
      type: "object",
    }),
  });
}

async function waitForJob(
  job: SubagentJob,
  timeout: number | undefined,
  abortSignal: AbortSignal | undefined
) {
  if (abortSignal?.aborted) {
    return;
  }

  const timeoutMs = Math.min(timeout ?? 60_000, 600_000);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const abortPromise = abortSignal
    ? new Promise<void>((resolve) => {
        abortListener = resolve;
        abortSignal.addEventListener("abort", abortListener, { once: true });
      })
    : undefined;
  try {
    await Promise.race([
      job.promise,
      ...(abortPromise ? [abortPromise] : []),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (abortListener) {
      abortSignal?.removeEventListener("abort", abortListener);
    }
  }
}
