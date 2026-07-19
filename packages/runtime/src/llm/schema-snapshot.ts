import { asSchema, jsonSchema, type ToolSet } from "ai";
import {
  isPlainRecord,
  propertyDescriptorInPrototypeChain,
} from "./tool-property-descriptors";

export const INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE = Symbol(
  "input-schema-snapshot-unavailable"
);

export function snapshotInputSchema(
  value: unknown
): ToolSet[string] | unknown | typeof INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE {
  if (typeof value === "function" || hasStandardSchemaMarker(value)) {
    return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
  }
  try {
    const resolved = asSchema(
      value as Parameters<typeof asSchema>[0]
    ).jsonSchema;
    if (observeNativePromiseRejection(resolved) || hasThenProperty(resolved)) {
      return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
    }
    const snapshot = immutableJsonSnapshot(resolved);
    return snapshot === INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE
      ? snapshot
      : jsonSchema(snapshot as Parameters<typeof jsonSchema>[0]);
  } catch {
    return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
  }
}

function hasStandardSchemaMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    propertyDescriptorInPrototypeChain(value, "~standard") !== undefined
  );
}

function observeNativePromiseRejection(value: unknown): boolean {
  try {
    Promise.prototype.then.call(value, undefined, () => undefined);
    return true;
  } catch {
    return false;
  }
}

function hasThenProperty(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  const descriptor = propertyDescriptorInPrototypeChain(value, "then");
  return Boolean(
    descriptor &&
      (!("value" in descriptor) || typeof descriptor.value === "function")
  );
}

function immutableJsonSnapshot(
  value: unknown,
  ancestors = new WeakSet<object>()
): unknown | typeof INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
  }
  if (!(Array.isArray(value) || isPlainRecord(value))) {
    return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
  }
  ancestors.add(value);
  try {
    if (hasEnumerableSymbol(value)) {
      return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
    }
    return Array.isArray(value)
      ? immutableJsonArraySnapshot(value, ancestors)
      : immutableJsonObjectSnapshot(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function immutableJsonArraySnapshot(
  value: readonly unknown[],
  ancestors: WeakSet<object>
): unknown | typeof INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE {
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
  }
  const keys = Object.keys(value);
  if (keys.length !== length) {
    return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const nested = snapshotJsonDataProperty(value, String(index), ancestors);
    if (nested === INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE) {
      return nested;
    }
    snapshot.push(nested);
  }
  return Object.freeze(snapshot);
}

function immutableJsonObjectSnapshot(
  value: object,
  ancestors: WeakSet<object>
): unknown | typeof INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE {
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    const nested = snapshotJsonDataProperty(value, key, ancestors);
    if (nested === INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE) {
      return nested;
    }
    snapshot[key] = nested;
  }
  return Object.freeze(snapshot);
}

function snapshotJsonDataProperty(
  value: object,
  key: string,
  ancestors: WeakSet<object>
): unknown | typeof INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!(descriptor?.enumerable && "value" in descriptor)) {
    return INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE;
  }
  return immutableJsonSnapshot(descriptor.value, ancestors);
}

function hasEnumerableSymbol(value: object): boolean {
  return Object.getOwnPropertySymbols(value).some(
    (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
  );
}
