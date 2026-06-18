import type { Tool, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import type {
  ExecutionHost,
  RunCheckpoint,
  RunRecord,
} from "../execution/host/types";
import { createInMemoryExecutionHost } from "../execution/memory";

export interface GenerateTextToolOptions {
  readonly tools?: ToolSet;
}

export const createQueuedUserTurnRun = (runId = "run-1"): RunRecord => ({
  checkpointVersion: 0,
  kind: "user-turn",
  rootRunId: runId,
  runId,
  sessionKey: "session-1",
  status: "queued",
});

export function checkpointedTool(
  retryPolicy: "idempotent" | "manual-recovery" | "pure",
  execute: (input: unknown, options: unknown) => unknown
): Tool & { readonly retryPolicy: "idempotent" | "manual-recovery" | "pure" } {
  return {
    ...tool({
      execute,
      inputSchema: jsonSchema({
        additionalProperties: false,
        properties: {},
        type: "object",
      }),
    }),
    retryPolicy,
  };
}

export function toolOptions(toolCallId: string, signal: AbortSignal) {
  return {
    abortSignal: signal,
    context: undefined,
    messages: [],
    toolCallId,
  };
}

export function createCheckpointSpyHost(): {
  readonly checkpoints: RunCheckpoint[];
  readonly host: ExecutionHost;
} {
  const baseHost = createInMemoryExecutionHost();
  const checkpoints: RunCheckpoint[] = [];
  return {
    checkpoints,
    host: {
      kind: "execution",
      scheduler: baseHost.scheduler,
      store: {
        checkpoints: {
          append: async (checkpoint, options) => {
            checkpoints.push(checkpoint);
            return await baseHost.store.checkpoints.append(checkpoint, options);
          },
          latest: (runId) => baseHost.store.checkpoints.latest(runId),
        },
        events: baseHost.store.events,
        notifications: baseHost.store.notifications,
        runs: baseHost.store.runs,
        sessions: baseHost.store.sessions,
        transaction: (fn) => baseHost.store.transaction(fn),
      },
    },
  };
}
