import { jsonSchema, tool } from "ai";
import type { ExecutionHost } from "./execution/types";
import { cancelBackgroundChildRun } from "./subagent-background-child-run";
import {
  assertBackgroundTaskId,
  backgroundRunJobStatus,
  cancelJob,
  isActiveJob,
} from "./subagent-job-state";
import type { BackgroundCancelInput, SubagentJob } from "./subagent-types";

interface BackgroundToolScope {
  readonly childSessionKeyPrefix: string;
}

export function createBackgroundCancelTool(
  jobs: Map<string, SubagentJob>,
  executionHost?: ExecutionHost,
  scope?: BackgroundToolScope
) {
  return tool<BackgroundCancelInput, unknown, Record<string, unknown>>({
    description: "Cancel an active background subagent job.",
    execute: async (input: BackgroundCancelInput) => {
      assertBackgroundTaskId(input.task_id, "background_cancel");
      const job = jobs.get(input.task_id);
      if (!job) {
        const durableCancel = await durableBackgroundCancel(
          input.task_id,
          executionHost,
          scope
        );
        if (durableCancel) {
          return durableCancel;
        }

        throw new Error(`Unknown background subagent task ${input.task_id}.`);
      }

      const durableLocalCancel = await cancelDurableLocalJob(job, scope);
      if (durableLocalCancel) {
        return durableLocalCancel;
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

async function cancelDurableLocalJob(
  job: SubagentJob,
  scope: BackgroundToolScope | undefined
): Promise<Record<string, unknown> | null> {
  if (!(job.executionHost && job.childRunId)) {
    return null;
  }

  const record = await job.executionHost.store.runs.get(job.childRunId);
  if (record?.kind !== "background-subagent") {
    return null;
  }
  if (scope && !record.sessionKey.startsWith(scope.childSessionKeyPrefix)) {
    return null;
  }

  const currentStatus = backgroundRunJobStatus(record.status);
  if (!currentStatus) {
    return null;
  }
  if (currentStatus === "pending" || currentStatus === "running") {
    const cancelled = await cancelBackgroundChildRun({
      executionHost: job.executionHost,
      runId: record.runId,
    });
    const nextStatus = backgroundRunJobStatus(cancelled?.status);
    if (nextStatus === "cancelled") {
      cancelJob(job);
      return { status: "cancelled", task_id: job.id };
    }

    return { status: nextStatus ?? currentStatus, task_id: job.id };
  }

  return { status: currentStatus, task_id: job.id };
}

async function durableBackgroundCancel(
  taskId: string,
  executionHost: ExecutionHost | undefined,
  scope: BackgroundToolScope | undefined
): Promise<Record<string, unknown> | null> {
  if (!executionHost) {
    return null;
  }
  const host = executionHost;

  const record = await host.store.runs.get(`background:${taskId}`);
  if (record?.kind !== "background-subagent") {
    return null;
  }
  if (scope && !record.sessionKey.startsWith(scope.childSessionKeyPrefix)) {
    return null;
  }

  const currentStatus = backgroundRunJobStatus(record.status);
  if (!currentStatus) {
    return null;
  }

  if (currentStatus === "pending" || currentStatus === "running") {
    const cancelled = await cancelBackgroundChildRun({
      executionHost: host,
      runId: record.runId,
    });
    return {
      status: backgroundRunJobStatus(cancelled?.status) ?? currentStatus,
      task_id: taskId,
    };
  }

  return { status: currentStatus, task_id: taskId };
}
