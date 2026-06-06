import { jsonSchema, tool } from "ai";
import {
  assertBackgroundTaskId,
  cancelJob,
  isActiveJob,
} from "./subagent-jobs";
import type { BackgroundCancelInput, SubagentJob } from "./subagent-types";

export function createBackgroundCancelTool(jobs: Map<string, SubagentJob>) {
  return tool<BackgroundCancelInput, unknown, Record<string, unknown>>({
    description: "Cancel an active background subagent job.",
    execute: (input: BackgroundCancelInput) => {
      assertBackgroundTaskId(input.task_id, "background_cancel");
      const job = jobs.get(input.task_id);
      if (!job) {
        throw new Error(`Unknown background subagent task ${input.task_id}.`);
      }

      if (isActiveJob(job.status)) {
        cancelJob(job);
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
