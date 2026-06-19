import type { ExecutionHost, ExecutionScheduler } from "../../../execution";
import { FileExecutionStore } from "../storage/file-execution-store";
import {
  appendScheduledNodeRun,
  appendScheduledNodeThreadPrompt,
} from "./scheduled-work-queue";

export interface NodeFileExecutionHostOptions {
  readonly directory: string;
}

export function createNodeFileExecutionHost({
  directory,
}: NodeFileExecutionHostOptions): ExecutionHost {
  return {
    kind: "execution",
    scheduler: createNodeFileScheduler({ directory }),
    store: new FileExecutionStore(directory),
  };
}

export function createNodeFileScheduler({
  directory,
}: NodeFileExecutionHostOptions): ExecutionScheduler {
  return {
    enqueueRun: async (runId) => {
      await appendScheduledNodeRun(directory, runId);
    },
    resumeThread: async (threadKey, options) => {
      await appendScheduledNodeThreadPrompt(directory, {
        idempotencyKey: options.idempotencyKey,
        notificationId: options.notificationId,
        runId: options.runId,
        threadKey,
      });
    },
  };
}
