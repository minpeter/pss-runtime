import { EvlogError, initLogger, log } from "evlog";

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
