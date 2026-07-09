import type { AgentHost, ExecutionScheduler } from "../../../execution";
import { FileAttachmentStore } from "../storage/file-attachment-store";
import { FileExecutionStore } from "../storage/file-execution-store";
import {
  appendScheduledNodeRun,
  appendScheduledNodeThreadPrompt,
} from "./scheduled-work-store";

export interface FileHostOptions {
  readonly directory: string;
}

export function createFileHost({ directory }: FileHostOptions): AgentHost {
  return {
    attachmentStore: new FileAttachmentStore(directory),
    scheduler: createFileScheduler({ directory }),
    store: new FileExecutionStore(directory),
  };
}

export function createFileScheduler({
  directory,
}: FileHostOptions): ExecutionScheduler {
  return {
    enqueueRun: async (runId, options) => {
      await appendScheduledNodeRun(directory, runId, options);
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
