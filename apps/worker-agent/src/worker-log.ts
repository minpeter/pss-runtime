import { initLogger, log } from "evlog";
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

/** Structured info event (pretty tree when enabled). */
export function logInfo(event: Record<string, unknown>): void {
  ensureWorkerLogger();
  log.info(event);
}

/** Structured warn event. */
export function logWarn(event: Record<string, unknown>): void {
  ensureWorkerLogger();
  log.warn(event);
}

/** Structured error event or Error object. */
export function logError(
  event: Error | Record<string, unknown>,
  context?: Record<string, unknown>
): void {
  ensureWorkerLogger();
  if (event instanceof Error) {
    log.error({
      ...(context ?? {}),
      error: event.message,
      errorName: event.name,
    });
    return;
  }
  log.error(event);
}

/** Tagged one-liner (startup / CLI). */
export function logTagged(
  level: "info" | "warn" | "error",
  tag: string,
  message: string
): void {
  ensureWorkerLogger();
  log[level](tag, message);
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
