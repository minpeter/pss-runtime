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
  return process.env.ENVIRONMENT !== "production";
}

function isProductionEnvironment(): boolean {
  if (typeof process === "undefined") {
    return false;
  }
  return process.env.ENVIRONMENT === "production";
}

/** Idempotent module-scope init for Worker + Durable Object isolates. */
export function ensureWorkerLogger(): void {
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
      ...(typeof process !== "undefined" && process.env.CF_VERSION_METADATA
        ? { version: process.env.CF_VERSION_METADATA }
        : {}),
    },
    pretty,
    // Explicit PII safety net (also default in prod; set always for defense in depth).
    redact: true,
    // Workers: objects for CF Observability parsing.
    stringify: false,
    // Low traffic today — keep 100% but structure keep rules for scale.
    ...(production
      ? {
          sampling: {
            rates: {
              debug: 0,
              error: 100,
              info: 100,
              warn: 100,
            },
            keep: [{ status: 400 }, { duration: 3000 }, { path: "/turn" }],
          },
        }
      : {}),
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

/**
 * One-liner for CLI/startup (relay, webhook setup).
 * Uses structured object form so pretty mode flushes via process.stdout.write
 * (same channel as request wide events). The tag-string API uses console.log
 * and loses the wrangler `stdout:` prefix.
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
      // base64 length ≈ 4/3 of raw bytes; useful size signal without decoding.
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
