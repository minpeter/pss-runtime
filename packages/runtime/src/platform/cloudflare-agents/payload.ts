const payloadVersion = 1;
const maxIdLength = 1024;
const maxPrefixLength = 256;

export const defaultCloudflareAgentsDelayedResumeCallback =
  "resumePssRuntimeFiber";
export const pssRunFiberName = "pss-runtime:resume-run";
export const pssThreadFiberName = "pss-runtime:resume-thread";

export interface CloudflareAgentsRunFiberPayload {
  readonly kind: "run";
  readonly prefix: string;
  readonly runId: string;
  readonly version: 1;
}

export interface CloudflareAgentsThreadFiberPayload {
  readonly idempotencyKey?: string;
  readonly kind: "thread";
  readonly notificationId?: string;
  readonly prefix: string;
  readonly runId: string;
  readonly threadKey: string;
  readonly version: 1;
}

export type CloudflareAgentsFiberPayload =
  | CloudflareAgentsRunFiberPayload
  | CloudflareAgentsThreadFiberPayload;

export function cloudflareAgentsRunPayload({
  prefix,
  runId,
}: {
  readonly prefix: string;
  readonly runId: string;
}): CloudflareAgentsRunFiberPayload {
  assertPayloadString("prefix", prefix, maxPrefixLength);
  assertPayloadString("runId", runId, maxIdLength);
  return { kind: "run", prefix, runId, version: payloadVersion };
}

export function cloudflareAgentsThreadPayload({
  idempotencyKey,
  notificationId,
  prefix,
  runId,
  threadKey,
}: {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly prefix: string;
  readonly runId: string;
  readonly threadKey: string;
}): CloudflareAgentsThreadFiberPayload {
  assertOptionalPayloadString("idempotencyKey", idempotencyKey, maxIdLength);
  assertOptionalPayloadString("notificationId", notificationId, maxIdLength);
  assertPayloadString("prefix", prefix, maxPrefixLength);
  assertPayloadString("runId", runId, maxIdLength);
  assertPayloadString("threadKey", threadKey, maxIdLength);
  return {
    idempotencyKey,
    kind: "thread",
    notificationId,
    prefix,
    runId,
    threadKey,
    version: payloadVersion,
  };
}

export function cloudflareAgentsFiberName(
  payload: CloudflareAgentsFiberPayload
): string {
  switch (payload.kind) {
    case "run":
      return pssRunFiberName;
    case "thread":
      return pssThreadFiberName;
    default:
      return assertNeverPayload(payload);
  }
}

export function cloudflareAgentsFiberIdempotencyKey(
  payload: CloudflareAgentsFiberPayload
): string {
  switch (payload.kind) {
    case "run":
      return `pss-runtime:${payload.prefix}:run:${payload.runId}`;
    case "thread":
      return `pss-runtime:${payload.prefix}:thread:${
        payload.idempotencyKey ?? payload.runId
      }`;
    default:
      return assertNeverPayload(payload);
  }
}

export function cloudflareAgentsFiberMetadata(
  payload: CloudflareAgentsFiberPayload
): Record<string, unknown> {
  switch (payload.kind) {
    case "run":
      return {
        kind: payload.kind,
        prefix: payload.prefix,
        runId: payload.runId,
        version: payload.version,
      };
    case "thread":
      return {
        idempotencyKey: payload.idempotencyKey,
        kind: payload.kind,
        notificationId: payload.notificationId,
        prefix: payload.prefix,
        runId: payload.runId,
        threadKey: payload.threadKey,
        version: payload.version,
      };
    default:
      return assertNeverPayload(payload);
  }
}

export function parseCloudflareAgentsFiberPayload(
  value: unknown
): CloudflareAgentsFiberPayload | null {
  if (!isRecord(value) || value.version !== payloadVersion) {
    return null;
  }
  if (value.kind === "run") {
    if (!hasRunPayloadStrings(value)) {
      return null;
    }
    return cloudflareAgentsRunPayload({
      prefix: value.prefix,
      runId: value.runId,
    });
  }
  if (value.kind === "thread") {
    if (!hasThreadPayloadStrings(value)) {
      return null;
    }
    return cloudflareAgentsThreadPayload({
      idempotencyKey: value.idempotencyKey,
      notificationId: value.notificationId,
      prefix: value.prefix,
      runId: value.runId,
      threadKey: value.threadKey,
    });
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function hasRunPayloadStrings(
  value: Record<string, unknown>
): value is Record<string, unknown> & { prefix: string; runId: string } {
  return (
    isPayloadString(value.prefix, maxPrefixLength) &&
    isPayloadString(value.runId, maxIdLength)
  );
}

function hasThreadPayloadStrings(
  value: Record<string, unknown>
): value is Record<string, unknown> & {
  idempotencyKey?: string;
  notificationId?: string;
  prefix: string;
  runId: string;
  threadKey: string;
} {
  return (
    isOptionalPayloadString(value.idempotencyKey, maxIdLength) &&
    isOptionalPayloadString(value.notificationId, maxIdLength) &&
    isPayloadString(value.prefix, maxPrefixLength) &&
    isPayloadString(value.runId, maxIdLength) &&
    isPayloadString(value.threadKey, maxIdLength)
  );
}

function isPayloadString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isOptionalPayloadString(
  value: unknown,
  maxLength: number
): value is string | undefined {
  return value === undefined || isPayloadString(value, maxLength);
}

function assertPayloadString(
  name: string,
  value: string,
  maxLength: number
): void {
  if (!isPayloadString(value, maxLength)) {
    throw new TypeError(
      `Cloudflare Agents payload ${name} must be a non-empty string up to ${maxLength} characters`
    );
  }
}

function assertOptionalPayloadString(
  name: string,
  value: string | undefined,
  maxLength: number
): void {
  if (!isOptionalPayloadString(value, maxLength)) {
    throw new TypeError(
      `Cloudflare Agents payload ${name} must be a non-empty string up to ${maxLength} characters when provided`
    );
  }
}

function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}
