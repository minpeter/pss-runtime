import { initLogger, log } from "evlog";
import {
  createWorkersLogger,
  type WorkerExecutionContext,
} from "evlog/workers";

let initialized = false;

/** Pretty tree under local wrangler; production keeps object dumps for CF logs. */
function shouldPrettyPrint(): boolean {
  if (typeof process === "undefined") {
    return true;
  }
  // workerd sets NODE_ENV=production under `wrangler dev` too.
  return process.env.ENVIRONMENT !== "production";
}

function isProductionEnvironment(): boolean {
  if (typeof process === "undefined") {
    return false;
  }
  return process.env.ENVIRONMENT === "production";
}

export interface EnsureWorkerLoggerOptions {
  readonly version?: string;
}

/** Idempotent module-scope init for Worker + Durable Object isolates. */
export function ensureWorkerLogger(
  options: EnsureWorkerLoggerOptions = {}
): void {
  if (initialized) {
    return;
  }
  const pretty = shouldPrettyPrint();
  const production = isProductionEnvironment();
  let environment = "development";
  if (production) {
    environment = "production";
  } else if (typeof process !== "undefined" && process.env.ENVIRONMENT) {
    environment = process.env.ENVIRONMENT;
  }
  initLogger({
    env: {
      service: "pss-worker-agent",
      environment,
      ...(options.version ? { version: options.version } : {}),
    },
    pretty,
    redact: true,
    // Objects for Cloudflare Observability parsing (not JSON strings).
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

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Structured info event via global evlog `log` (object form → pretty tree + colors).
 * Prefer this over hand-rolled stdout for host-owned diagnostics.
 */
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

/**
 * CLI/startup one-liner (relay, webhook). Object form so pretty mode uses
 * process.stdout.write (same channel as request wide events).
 */
export function logTagged(
  level: "info" | "warn" | "error",
  tag: string,
  message: string
): void {
  ensureWorkerLogger();
  const event = { message, scope: tag };
  if (level === "error") {
    log.error(event);
    return;
  }
  if (level === "warn") {
    log.warn(event);
    return;
  }
  log.info(event);
}

export function attachmentLogFields(
  attachments: readonly {
    readonly dataBase64: string;
    readonly mediaType: string;
  }[]
): {
  readonly attachments: {
    readonly count: number;
    readonly mediaTypes: readonly string[];
    readonly payloadBytes: number;
  };
} {
  return {
    attachments: {
      count: attachments.length,
      mediaTypes: attachments.map((attachment) => attachment.mediaType),
      // base64 length ≈ 4/3 of raw bytes; size signal without decoding.
      payloadBytes: attachments.reduce(
        (sum, attachment) =>
          sum + Math.floor((attachment.dataBase64.length * 3) / 4),
        0
      ),
    },
  };
}

export function summarizeImagePrepares(
  prepares: readonly {
    readonly path: string;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly inputMediaType: string;
    readonly outputMediaType: string;
  }[]
): {
  readonly images?: {
    readonly count: number;
    readonly prepares: readonly {
      readonly path: string;
      readonly inputBytes: number;
      readonly outputBytes: number;
      readonly inputMediaType: string;
      readonly outputMediaType: string;
    }[];
  };
} {
  if (prepares.length === 0) {
    return {};
  }
  return {
    images: {
      count: prepares.length,
      prepares: prepares.map((prepare) => ({
        inputBytes: prepare.inputBytes,
        inputMediaType: prepare.inputMediaType,
        outputBytes: prepare.outputBytes,
        outputMediaType: prepare.outputMediaType,
        path: prepare.path,
      })),
    },
  };
}

/** Structured fields for a single image-prepare evlog event (no hand-rolled trees). */
export function imagePrepareLogEvent(diagnostics: {
  readonly path: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly inputMediaType: string;
  readonly outputMediaType: string;
  readonly maxImageBytes: number;
  readonly decodedWidth?: number;
  readonly decodedHeight?: number;
  readonly hasAlpha?: boolean;
  readonly message?: string;
}): Record<string, unknown> {
  return {
    message: diagnostics.message ?? "pss-runtime image-prepare",
    path: diagnostics.path,
    inputBytes: diagnostics.inputBytes,
    outputBytes: diagnostics.outputBytes,
    inputMediaType: diagnostics.inputMediaType,
    outputMediaType: diagnostics.outputMediaType,
    maxImageBytes: diagnostics.maxImageBytes,
    ...(diagnostics.decodedWidth === undefined
      ? {}
      : { decodedWidth: diagnostics.decodedWidth }),
    ...(diagnostics.decodedHeight === undefined
      ? {}
      : { decodedHeight: diagnostics.decodedHeight }),
    ...(diagnostics.hasAlpha === undefined
      ? {}
      : { hasAlpha: diagnostics.hasAlpha }),
  };
}
