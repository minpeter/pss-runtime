const payloadVersion = 1;
const maxIdLength = 1024;
const maxPrefixLength = 256;

export const defaultCloudflareAgentsDelayedResumeCallback =
  "resumePssRuntimeFiber";
export const pssRunFiberName = "pss-runtime:resume-run";
export const pssThreadFiberName = "pss-runtime:resume-thread";

export interface CloudflareAgentsRunFiberPayload {
  readonly attempt?: number;
  readonly kind: "run";
  readonly prefix: string;
  readonly runId: string;
  readonly version: 1;
}

export interface CloudflareAgentsThreadFiberPayload {
  readonly attempt?: number;
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
  attempt,
  prefix,
  runId,
}: {
  readonly attempt?: number;
  readonly prefix: string;
  readonly runId: string;
}): CloudflareAgentsRunFiberPayload {
  assertOptionalPayloadAttempt("attempt", attempt);
  assertPayloadString("prefix", prefix, maxPrefixLength);
  assertPayloadString("runId", runId, maxIdLength);
  const payload: CloudflareAgentsRunFiberPayload = {
    kind: "run",
    prefix,
    runId,
    version: payloadVersion,
  };
  return attempt === undefined ? payload : { ...payload, attempt };
}

export function cloudflareAgentsThreadPayload({
  attempt,
  idempotencyKey,
  notificationId,
  prefix,
  runId,
  threadKey,
}: {
  readonly attempt?: number;
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly prefix: string;
  readonly runId: string;
  readonly threadKey: string;
}): CloudflareAgentsThreadFiberPayload {
  assertOptionalPayloadAttempt("attempt", attempt);
  assertOptionalPayloadString("idempotencyKey", idempotencyKey, maxIdLength);
  assertOptionalPayloadString("notificationId", notificationId, maxIdLength);
  assertPayloadString("prefix", prefix, maxPrefixLength);
  assertPayloadString("runId", runId, maxIdLength);
  assertPayloadString("threadKey", threadKey, maxIdLength);
  const payload: CloudflareAgentsThreadFiberPayload = {
    idempotencyKey,
    kind: "thread",
    notificationId,
    prefix,
    runId,
    threadKey,
    version: payloadVersion,
  };
  return attempt === undefined ? payload : { ...payload, attempt };
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
      return keyWithAttempt(
        `pss-runtime:run:${idempotencyKeyPart(
          payload.prefix
        )}:${idempotencyKeyPart(payload.runId)}`,
        payload.attempt
      );
    case "thread":
      return keyWithAttempt(
        `pss-runtime:thread:${idempotencyKeyPart(
          payload.prefix
        )}:${threadIdempotencyPart(payload)}`,
        payload.attempt
      );
    default:
      return assertNeverPayload(payload);
  }
}

export function cloudflareAgentsFiberMetadata(
  payload: CloudflareAgentsFiberPayload
): Record<string, unknown> {
  switch (payload.kind) {
    case "run":
      return withOptionalAttempt(
        {
          kind: payload.kind,
          prefix: payload.prefix,
          runId: payload.runId,
          version: payload.version,
        },
        payload.attempt
      );
    case "thread":
      return withOptionalAttempt(
        {
          idempotencyKey: payload.idempotencyKey,
          kind: payload.kind,
          notificationId: payload.notificationId,
          prefix: payload.prefix,
          runId: payload.runId,
          threadKey: payload.threadKey,
          version: payload.version,
        },
        payload.attempt
      );
    default:
      return assertNeverPayload(payload);
  }
}

function withOptionalAttempt(
  metadata: Record<string, unknown>,
  attempt: number | undefined
): Record<string, unknown> {
  return attempt === undefined
    ? metadata
    : {
        ...metadata,
        attempt,
      };
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
      attempt: value.attempt,
      prefix: value.prefix,
      runId: value.runId,
    });
  }
  if (value.kind === "thread") {
    if (!hasThreadPayloadStrings(value)) {
      return null;
    }
    return cloudflareAgentsThreadPayload({
      attempt: value.attempt,
      idempotencyKey: value.idempotencyKey,
      notificationId: value.notificationId,
      prefix: value.prefix,
      runId: value.runId,
      threadKey: value.threadKey,
    });
  }
  return null;
}

function threadIdempotencyPart(
  payload: CloudflareAgentsThreadFiberPayload
): string {
  if (payload.idempotencyKey !== undefined) {
    return idempotencyKeyPart(payload.idempotencyKey);
  }
  return `${idempotencyKeyPart(payload.runId)}:${idempotencyKeyPart(
    payload.threadKey
  )}`;
}

function keyWithAttempt(key: string, attempt: number | undefined): string {
  return attempt === undefined ? key : `${key}:attempt:${attempt}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function hasRunPayloadStrings(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  attempt?: number;
  prefix: string;
  runId: string;
} {
  return (
    isOptionalPayloadAttempt(value.attempt) &&
    isPayloadString(value.prefix, maxPrefixLength) &&
    isPayloadString(value.runId, maxIdLength)
  );
}

function hasThreadPayloadStrings(
  value: Record<string, unknown>
): value is Record<string, unknown> & {
  attempt?: number;
  idempotencyKey?: string;
  notificationId?: string;
  prefix: string;
  runId: string;
  threadKey: string;
} {
  return (
    isOptionalPayloadAttempt(value.attempt) &&
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

function isOptionalPayloadAttempt(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
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

function assertOptionalPayloadAttempt(
  name: string,
  value: number | undefined
): void {
  if (!isOptionalPayloadAttempt(value)) {
    throw new TypeError(
      `Cloudflare Agents payload ${name} must be a non-negative safe integer when provided`
    );
  }
}

function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}

function idempotencyKeyPart(value: string): string {
  return `${value.length}:${value}`;
}
