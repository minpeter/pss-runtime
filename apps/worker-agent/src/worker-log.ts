import { initLogger } from "evlog";
import {
  createWorkersLogger,
  type WorkerExecutionContext,
} from "evlog/workers";

let initialized = false;

/**
 * Pretty tree in local wrangler. Production stays object dumps for CF logs.
 *
 * Note: `initWorkersLogger` hardcodes `pretty: false` / `stringify: false`
 * (after spreading options), so we call `initLogger` directly.
 */
function shouldPrettyPrint(): boolean {
  if (typeof process === "undefined") {
    return true;
  }
  // Do not use NODE_ENV: workerd sets it to "production" under `wrangler dev` too.
  // Only suppress pretty when our wrangler var ENVIRONMENT is explicitly production.
  return process.env.ENVIRONMENT !== "production";
}

/** Idempotent module-scope init for Worker + Durable Object isolates. */
export function ensureWorkerLogger(): void {
  if (initialized) {
    return;
  }
  const pretty = shouldPrettyPrint();
  initLogger({
    env: {
      service: "pss-worker-agent",
      ...(typeof process !== "undefined" && process.env.ENVIRONMENT
        ? { environment: process.env.ENVIRONMENT }
        : { environment: pretty ? "development" : "production" }),
    },
    // Workers adapter docs recommend stringify:false so CF logs stay objects.
    pretty,
    stringify: false,
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
