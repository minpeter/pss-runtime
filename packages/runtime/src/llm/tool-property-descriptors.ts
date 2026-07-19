import { isRecord as isObjectRecord } from "../internal/guards";
import { ModelToolSelectionError } from "./model-step-error";

export { isObjectRecord };

export const MISSING_DATA_PROPERTY = Symbol("missing-data-property");

export function propertyDescriptorInPrototypeChain(
  value: object,
  property: string
): PropertyDescriptor | undefined {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor) {
      return descriptor;
    }
    current = Object.getPrototypeOf(current);
  }
}

export function propertyCanProvideValue(
  descriptor: PropertyDescriptor | undefined,
  dataType?: "string"
): boolean {
  if (!descriptor) {
    return false;
  }
  if ("value" in descriptor) {
    return dataType === undefined || typeof descriptor.value === dataType;
  }
  return typeof descriptor.get === "function";
}

export function dataPropertyInPrototypeChain(
  value: object,
  property: string
): unknown | typeof MISSING_DATA_PROPERTY {
  const descriptor = propertyDescriptorInPrototypeChain(value, property);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : MISSING_DATA_PROPERTY;
}

export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (!isObjectRecord(value) || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function ownProperty(
  value: Record<string, unknown>,
  property: string
): unknown {
  return Object.hasOwn(value, property) ? value[property] : undefined;
}

export function ownDataProperty(
  value: Record<string, unknown>,
  property: string,
  context: string
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (!descriptor) {
    return;
  }
  if (!("value" in descriptor)) {
    throw new ModelToolSelectionError(
      `${context} field ${JSON.stringify(property)} must be a data property.`
    );
  }
  return descriptor.value;
}

export type SafeDataProperty =
  | { readonly status: "accessor" }
  | { readonly status: "data"; readonly value: unknown }
  | { readonly status: "missing" };

export function safeOwnDataProperty(
  value: Record<string, unknown>,
  property: string
): SafeDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (!descriptor) {
    return { status: "missing" };
  }
  return "value" in descriptor
    ? { status: "data", value: descriptor.value }
    : { status: "accessor" };
}

export function dataPropertyValue(property: SafeDataProperty): unknown {
  return property.status === "data" ? property.value : undefined;
}

export function fingerprintValueIsSafe(
  value: unknown,
  seen = new WeakSet<object>()
): boolean {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return true;
  }
  if (!(Array.isArray(value) || isPlainRecord(value))) {
    return false;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !(
        descriptor &&
        "value" in descriptor &&
        fingerprintValueIsSafe(descriptor.value, seen)
      )
    ) {
      return false;
    }
  }
  return true;
}

export function canonicalFingerprintValue(
  value: unknown,
  ancestors = new WeakSet<object>()
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return { type: "number", value: "NaN" };
    }
    if (value === Number.POSITIVE_INFINITY) {
      return { type: "number", value: "+Infinity" };
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return { type: "number", value: "-Infinity" };
    }
    if (Object.is(value, -0)) {
      return { type: "number", value: "-0" };
    }
    return value;
  }
  if (value === undefined) {
    return { type: "undefined" };
  }
  if (typeof value === "bigint") {
    return { type: "bigint", value: value.toString() };
  }
  if (typeof value !== "object") {
    return { type: typeof value };
  }
  if (ancestors.has(value)) {
    return { type: "circular" };
  }
  ancestors.add(value);
  const entries = Object.keys(value)
    .sort(compareToolNames)
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return [
        key,
        descriptor && "value" in descriptor
          ? canonicalFingerprintValue(descriptor.value, ancestors)
          : { type: "accessor" },
      ];
    });
  const canonical = Array.isArray(value)
    ? {
        entries,
        length: Object.getOwnPropertyDescriptor(value, "length")?.value ?? null,
        type: "array",
      }
    : entries;
  ancestors.delete(value);
  return canonical;
}

export function compareToolNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
