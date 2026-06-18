export const DEFAULT_STORAGE_PAYLOAD_MAX_BYTES = 1_900_000;

export type StoragePayloadKind =
  | "checkpoint"
  | "event"
  | "notification-record"
  | "run-record"
  | "thread-message"
  | "thread-state";

export interface StoragePayloadBudgetOptions {
  readonly maxPayloadBytes?: number;
}

export class StoragePayloadTooLargeError extends Error {
  readonly byteLength: number;
  readonly maxBytes: number;
  readonly payloadKind: StoragePayloadKind;

  constructor({
    byteLength,
    maxBytes,
    payloadKind,
  }: {
    readonly byteLength: number;
    readonly maxBytes: number;
    readonly payloadKind: StoragePayloadKind;
  }) {
    super(
      `Cloudflare storage ${payloadKind} payload is ${byteLength} bytes, exceeding the ${maxBytes} byte budget`
    );
    this.name = "StoragePayloadTooLargeError";
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
    this.payloadKind = payloadKind;
  }
}

export class StoragePayloadSerializationError extends Error {
  readonly payloadKind: StoragePayloadKind;

  constructor(payloadKind: StoragePayloadKind) {
    super(`Cloudflare storage ${payloadKind} payload is not JSON serializable`);
    this.name = "StoragePayloadSerializationError";
    this.payloadKind = payloadKind;
  }
}

const textEncoder = new TextEncoder();

export function resolveStoragePayloadMaxBytes(
  options: StoragePayloadBudgetOptions = {}
): number {
  return options.maxPayloadBytes ?? DEFAULT_STORAGE_PAYLOAD_MAX_BYTES;
}

export function serializedJsonByteLength(serialized: string): number {
  return textEncoder.encode(serialized).byteLength;
}

export function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : serializedJsonByteLength(serialized);
}

export function assertJsonPayloadWithinBudget(
  payloadKind: StoragePayloadKind,
  value: unknown,
  maxBytes = DEFAULT_STORAGE_PAYLOAD_MAX_BYTES
): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new StoragePayloadSerializationError(payloadKind);
  }
  assertSerializedJsonPayloadWithinBudget(payloadKind, serialized, maxBytes);
}

export function stringifyJsonPayloadWithinBudget(
  payloadKind: StoragePayloadKind,
  value: unknown,
  maxBytes = DEFAULT_STORAGE_PAYLOAD_MAX_BYTES
): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new StoragePayloadSerializationError(payloadKind);
  }
  assertSerializedJsonPayloadWithinBudget(payloadKind, serialized, maxBytes);
  return serialized;
}

export function assertSerializedJsonPayloadWithinBudget(
  payloadKind: StoragePayloadKind,
  serialized: string,
  maxBytes = DEFAULT_STORAGE_PAYLOAD_MAX_BYTES
): void {
  const byteLength = serializedJsonByteLength(serialized);
  if (byteLength > maxBytes) {
    throw new StoragePayloadTooLargeError({
      byteLength,
      maxBytes,
      payloadKind,
    });
  }
}
