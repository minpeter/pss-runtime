import { fingerprintTools, type ToolSet } from "ai";
import {
  INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE,
  snapshotInputSchema,
} from "./schema-snapshot";
import {
  canonicalFingerprintValue,
  dataPropertyValue,
  fingerprintValueIsSafe,
  isObjectRecord,
  safeOwnDataProperty,
} from "./tool-descriptor-utils";

export const SEMANTIC_TOOL_UNAVAILABLE = Symbol("semantic-tool-unavailable");

export function markSemanticToolUnavailable(
  definition: Record<PropertyKey, unknown>
): void {
  Object.defineProperty(definition, SEMANTIC_TOOL_UNAVAILABLE, { value: true });
}

export async function toolSemanticFingerprint(
  names: readonly string[],
  tools: ToolSet
): Promise<{
  readonly fingerprint: string;
  readonly unavailableToolCount: number;
}> {
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return await semanticToolEntry(name, tools[name]);
      } catch {
        return {
          name,
          representation: { status: "unavailable" },
          unavailable: true,
        };
      }
    })
  );
  const unavailableToolCount = entries.filter(
    (entry) => entry.unavailable
  ).length;
  const fingerprint = await jsonFingerprint(
    entries.map(({ name, representation }) => [name, representation])
  );
  return { fingerprint, unavailableToolCount };
}

async function semanticToolEntry(
  name: string,
  tool: ToolSet[string] | undefined
): Promise<{
  readonly name: string;
  readonly representation: unknown;
  readonly unavailable: boolean;
}> {
  if (!isObjectRecord(tool)) {
    return unavailableSemanticToolEntry(name);
  }
  if (
    Object.getOwnPropertyDescriptor(tool, SEMANTIC_TOOL_UNAVAILABLE)?.value ===
    true
  ) {
    return unavailableSemanticToolEntry(name);
  }
  const type = safeOwnDataProperty(tool, "type");
  if (type.status === "accessor") {
    return unavailableSemanticToolEntry(name);
  }
  if (type.status === "data" && type.value === "provider") {
    return providerSemanticToolEntry(name, tool);
  }
  return await functionSemanticToolEntry(name, tool);
}

function unavailableSemanticToolEntry(name: string, type?: string) {
  return {
    name,
    representation: {
      status: "unavailable",
      ...(type === undefined ? {} : { type }),
    },
    unavailable: true,
  } as const;
}

function providerSemanticToolEntry(
  name: string,
  tool: Record<string, unknown>
) {
  const id = safeOwnDataProperty(tool, "id");
  const args = safeOwnDataProperty(tool, "args");
  const providerOptions = safeOwnDataProperty(tool, "providerOptions");
  const idValue = dataPropertyValue(id);
  const argsValue = dataPropertyValue(args);
  const providerOptionsValue = dataPropertyValue(providerOptions);
  const unavailable =
    [id, args, providerOptions].some((field) => field.status === "accessor") ||
    typeof idValue !== "string" ||
    !fingerprintValueIsSafe(argsValue) ||
    !fingerprintValueIsSafe(providerOptionsValue);
  return {
    name,
    representation: unavailable
      ? { status: "unavailable", type: "provider" }
      : [
          "provider",
          idValue,
          canonicalFingerprintValue(argsValue),
          canonicalFingerprintValue(providerOptionsValue),
        ],
    unavailable,
  };
}

async function functionSemanticToolEntry(
  name: string,
  tool: Record<string, unknown>
) {
  const description = safeOwnDataProperty(tool, "description");
  const inputExamples = safeOwnDataProperty(tool, "inputExamples");
  const inputSchema = safeOwnDataProperty(tool, "inputSchema");
  const providerOptions = safeOwnDataProperty(tool, "providerOptions");
  const strict = safeOwnDataProperty(tool, "strict");
  const title = safeOwnDataProperty(tool, "title");
  const fields = [
    description,
    inputExamples,
    inputSchema,
    providerOptions,
    strict,
    title,
  ];
  if (fields.some((field) => field.status === "accessor")) {
    return unavailableSemanticToolEntry(name, "function");
  }

  const descriptionValue = dataPropertyValue(description);
  const strictValue = dataPropertyValue(strict);
  const titleValue = dataPropertyValue(title);
  const scalarMetadataUnavailable = !(
    (descriptionValue === undefined ||
      typeof descriptionValue === "string" ||
      typeof descriptionValue === "function") &&
    (strictValue === undefined || typeof strictValue === "boolean") &&
    (titleValue === undefined || typeof titleValue === "string")
  );
  const inputExamplesValue = dataPropertyValue(inputExamples);
  const providerOptionsValue = dataPropertyValue(providerOptions);
  const metadataUnavailable =
    scalarMetadataUnavailable ||
    !fingerprintValueIsSafe(inputExamplesValue) ||
    !fingerprintValueIsSafe(providerOptionsValue);
  const canonicalInputExamples = metadataUnavailable
    ? null
    : canonicalFingerprintValue(inputExamplesValue);
  const canonicalProviderOptions = metadataUnavailable
    ? null
    : canonicalFingerprintValue(providerOptionsValue);

  let definitionFingerprint: string | undefined;
  const schemaValue = dataPropertyValue(inputSchema);
  const schemaSnapshot = snapshotInputSchema(schemaValue);
  if (
    !scalarMetadataUnavailable &&
    schemaSnapshot !== INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE
  ) {
    try {
      const fingerprintable = Object.freeze({
        description: descriptionValue,
        inputSchema: schemaSnapshot,
        title: titleValue,
      }) as ToolSet[string];
      const result = await fingerprintTools({ [name]: fingerprintable });
      definitionFingerprint = Object.hasOwn(result, name)
        ? result[name]
        : undefined;
    } catch {
      definitionFingerprint = undefined;
    }
  }
  const unavailable = definitionFingerprint === undefined;
  return {
    name,
    representation: metadataUnavailable
      ? { status: "unavailable", type: "function" }
      : [
          "function",
          definitionFingerprint === undefined
            ? { status: "unavailable" }
            : { fingerprint: definitionFingerprint, status: "available" },
          canonicalInputExamples,
          canonicalProviderOptions,
          typeof strictValue === "boolean" ? strictValue : null,
        ],
    unavailable: unavailable || metadataUnavailable,
  };
}

export function countDynamicDescriptions(
  names: readonly string[],
  tools: ToolSet
): number {
  return names.filter((name) => {
    const tool = tools[name];
    if (!isObjectRecord(tool)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(tool, "description");
    return descriptor !== undefined && "value" in descriptor
      ? typeof descriptor.value === "function"
      : false;
  }).length;
}

async function jsonFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}
