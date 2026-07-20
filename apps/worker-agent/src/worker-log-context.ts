import {
  createWorkersLogger,
  type WorkerExecutionContext,
} from "evlog/workers";

import { ensureWorkerLogger } from "./worker-log-client";

export function createTurnLogger(
  request: Request,
  options?: { readonly executionCtx?: WorkerExecutionContext }
) {
  ensureWorkerLogger();
  return createWorkersLogger(request, {
    ...(options?.executionCtx ? { executionCtx: options.executionCtx } : {}),
  });
}

export function newCorrelationId(): string {
  return crypto.randomUUID();
}
