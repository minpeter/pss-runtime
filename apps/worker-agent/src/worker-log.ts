import { EvlogError, initLogger, log } from "evlog";
import {
  createWorkersLogger,
  type WorkerExecutionContext,
} from "evlog/workers";

let initialized = false;

/** Pretty tree under local wrangler; production keeps object dumps for CF logs. */
function shouldPrettyPrint(environment?: string): boolean {
  const envName =
    environment ??
    (typeof process === "undefined" ? undefined : process.env.ENVIRONMENT);
  // workerd sets NODE_ENV=production under `wrangler dev` too.
  return envName !== "production";
}

function resolveEnvironment(explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  if (typeof process !== "undefined" && process.env.ENVIRONMENT) {
    return process.env.ENVIRONMENT;
  }
  return "development";
}

export interface EnsureWorkerLoggerOptions {
  readonly environment?: string;
  readonly version?: string;
}

/** Idempotent module-scope init for Worker + Durable Object isolates. */
export function ensureWorkerLogger(
  options: EnsureWorkerLoggerOptions = {}
): void {
  if (initialized) {
    return;
  }
  const environment = resolveEnvironment(options.environment);
  const pretty = shouldPrettyPrint(environment);
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

/** Turn-scoped wide-event logger (`set` / `emit` / `error`). */
export interface WorkerTurnLogger {
  readonly emit: (overrides?: {
    readonly status?: number;
    readonly _forceKeep?: boolean;
  }) => unknown;
  readonly error: (
    error: Error | string | Record<string, unknown>,
    context?: Record<string, unknown>
  ) => void;
  readonly set: (data: Record<string, unknown>) => void;
}

export function createTurnLogger(
  request: Request,
  options?: { readonly executionCtx?: WorkerExecutionContext }
): WorkerTurnLogger {
  ensureWorkerLogger();
  return sealPostEmitAiFlushes(
    createWorkersLogger(request, {
      ...(options?.executionCtx ? { executionCtx: options.executionCtx } : {}),
    })
  );
}

type WorkersRequestLogger = ReturnType<typeof createWorkersLogger>;

/**
 * Drop `log.set({ ai })` after emit. createAILogger can flush once more after
 * the response is emitted; Workers mark drain started immediately so those
 * sets only produce noisy post-emit warnings.
 */
export function sealPostEmitAiFlushes(
  log: WorkersRequestLogger
): WorkerTurnLogger {
  let emitted = false;
  return {
    set(data) {
      if (emitted) {
        const keys = Object.keys(data);
        if (keys.length === 1 && keys[0] === "ai") {
          return;
        }
      }
      (log.set as (value: Record<string, unknown>) => void)(data);
    },
    emit(overrides) {
      const result = log.emit(overrides);
      emitted = true;
      return result;
    },
    error(err, context) {
      if (context) {
        log.error(err as never, context as never);
        return;
      }
      log.error(err as never);
    },
  };
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

/** Structured error event or Error object (preserves EvlogError catalog fields). */
export function logError(
  event: Error | Record<string, unknown>,
  context?: Record<string, unknown>
): void {
  ensureWorkerLogger();
  if (event instanceof EvlogError) {
    log.error({
      ...(context ?? {}),
      ...(event.code === undefined ? {} : { code: event.code }),
      ...(event.why === undefined ? {} : { why: event.why }),
      ...(event.fix === undefined ? {} : { fix: event.fix }),
      ...(event.status === undefined ? {} : { status: event.status }),
      error: event.message,
      errorName: event.name,
      ...(event.stack ? { stack: event.stack } : {}),
      ...causeFields(event.cause),
    });
    return;
  }
  if (event instanceof Error) {
    log.error({
      ...(context ?? {}),
      error: event.message,
      errorName: event.name,
      ...(event.stack ? { stack: event.stack } : {}),
      ...causeFields(event.cause),
    });
    return;
  }
  log.error(event);
}

function causeFields(cause: unknown): Record<string, unknown> {
  if (cause instanceof Error) {
    return {
      cause: cause.message,
      causeName: cause.name,
      ...(cause.stack ? { causeStack: cause.stack } : {}),
    };
  }
  if (cause !== undefined) {
    return { cause: String(cause) };
  }
  return {};
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

export function summarizeImageOmits(
  omits: readonly {
    readonly limit: string;
    readonly mediaType: string;
    readonly filename?: string;
  }[]
): {
  readonly imageOmits?: {
    readonly count: number;
    readonly omits: readonly {
      readonly limit: string;
      readonly mediaType: string;
      readonly filename?: string;
    }[];
  };
} {
  if (omits.length === 0) {
    return {};
  }
  return {
    imageOmits: {
      count: omits.length,
      omits: omits.map((omit) => ({
        limit: omit.limit,
        mediaType: omit.mediaType,
        ...(omit.filename === undefined ? {} : { filename: omit.filename }),
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
