import {
  createWorkersLogger,
  initWorkersLogger,
  type WorkerExecutionContext,
} from "evlog/workers";

let initialized = false;

/** Idempotent module-scope init for Worker + Durable Object isolates. */
export function ensureWorkerLogger(): void {
  if (initialized) {
    return;
  }
  initWorkersLogger({
    env: { service: "pss-worker-agent" },
  });
  initialized = true;
}

export function createTurnLogger(
  request: Request,
  options?: { readonly executionCtx?: WorkerExecutionContext }
) {
  ensureWorkerLogger();
  return createWorkersLogger(request, {
    ...(options?.executionCtx ? { executionCtx: options.executionCtx } : {}),
  });
}

export function attachmentLogFields(
  attachments: readonly {
    readonly dataBase64: string;
    readonly mediaType: string;
  }[]
): {
  readonly attachmentCount: number;
  readonly attachmentMediaTypes: readonly string[];
  readonly attachmentPayloadBytes: number;
} {
  return {
    attachmentCount: attachments.length,
    attachmentMediaTypes: attachments.map((attachment) => attachment.mediaType),
    // base64 length ≈ 4/3 of raw bytes; useful size signal without decoding.
    attachmentPayloadBytes: attachments.reduce(
      (sum, attachment) =>
        sum + Math.floor((attachment.dataBase64.length * 3) / 4),
      0
    ),
  };
}
