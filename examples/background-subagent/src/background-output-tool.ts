import type { ExecutionHost, RunStatus } from "@minpeter/pss-runtime/execution";
import { jsonSchema, tool } from "ai";
import { readerChildName } from "./delegate-tool";

interface BackgroundOutputInput {
  readonly task_id: string;
}

export function createBackgroundOutputTool(executionHost: ExecutionHost) {
  return tool<BackgroundOutputInput, unknown, Record<string, unknown>>({
    description: "백그라운드 reader 작업의 결과를 가져온다.",
    execute: async ({ task_id }) => {
      const record = await executionHost.store.runs.get(
        `background:${task_id}`
      );
      if (!record || record.kind !== "background-subagent") {
        throw new Error(`알 수 없는 백그라운드 작업 ${task_id}.`);
      }

      return {
        result: record.output,
        status: normalizeStatus(record.status),
        subagent: readerChildName,
        task_id,
      };
    },
    inputSchema: jsonSchema<BackgroundOutputInput>({
      additionalProperties: false,
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
      type: "object",
    }),
  });
}

function normalizeStatus(status: RunStatus): string {
  if (status === "completed" || status === "cancelled" || status === "error") {
    return status;
  }

  if (status === "running" || status === "leased") {
    return "running";
  }

  return "pending";
}
