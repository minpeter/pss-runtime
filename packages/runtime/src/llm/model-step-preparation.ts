import {
  asSchema,
  fingerprintTools,
  jsonSchema,
  type LanguageModel,
  type ToolChoice,
  type ToolSet,
} from "ai";
import {
  type ModelToolCacheFingerprintMetadata,
  noopRuntimeDiagnostics,
  type RuntimeDiagnosticsSink,
} from "../plugins/diagnostics";
import type { ThreadContextMessage } from "../thread/state/context";

export type PreparedModelToolChoice = ToolChoice<ToolSet>;

export interface PrepareModelStepInput {
  readonly history: readonly ThreadContextMessage[];
  readonly runtimeStepIndex: number;
  readonly signal: AbortSignal;
  readonly threadKey: string;
  readonly tools: Readonly<ToolSet>;
}

export interface PrepareModelStepResult {
  /** Additional per-step tools, appended after `alwaysActiveTools`. */
  readonly activeTools?: readonly string[];
  readonly model?: Exclude<LanguageModel, string>;
  readonly toolChoice?: PreparedModelToolChoice;
}

export type PrepareModelStep = (input: PrepareModelStepInput) =>
  | PrepareModelStepResult
  // biome-ignore lint/suspicious/noConfusingVoidType: async callbacks may intentionally resolve without a result.
  | PromiseLike<PrepareModelStepResult | void>
  | void;

/**
 * Compose an internal model transform without reading an unvalidated callback
 * result. This is intentionally not exported from the package root.
 */
export function mapPrepareModelStepModel(
  prepareModelStep: PrepareModelStep,
  mapModel: (
    model: Exclude<LanguageModel, string>
  ) => Exclude<LanguageModel, string>
): PrepareModelStep {
  return async (input) => {
    const prepared = parsePrepareModelStepResult(
      await prepareModelStep(input),
      Object.keys(input.tools).length
    );
    if (prepared?.model === undefined) {
      return prepared;
    }
    return {
      ...prepared,
      model: mapModel(prepared.model),
    };
  };
}

export class ModelToolSelectionError extends TypeError {
  readonly name = "ModelToolSelectionError";
}

const PREPARED_RESULT_KEYS = new Set(["activeTools", "model", "toolChoice"]);
const SEMANTIC_TOOL_FIELDS = [
  "args",
  "description",
  "id",
  "inputExamples",
  "inputSchema",
  "providerOptions",
  "strict",
  "title",
  "type",
] as const;
const SEMANTIC_TOOL_UNAVAILABLE = Symbol("semantic-tool-unavailable");
const INPUT_SCHEMA_SNAPSHOT_UNAVAILABLE = Symbol(
  "input-schema-snapshot-unavailable"
);

export interface ResolveModelStepOptions {
  readonly alwaysActiveTools?: readonly string[];
  readonly attemptId: string;
  readonly diagnostics?: RuntimeDiagnosticsSink;
  readonly history: readonly ThreadContextMessage[];
  readonly model: LanguageModel;
  readonly prepareModelStep?: PrepareModelStep;
  readonly runtimeStepIndex: number;
  readonly signal: AbortSignal;
  readonly threadKey?: string;
  readonly toolChoice?: PreparedModelToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export interface ResolvedModelStepOptions {
  readonly activeTools?: readonly string[];
  readonly model: LanguageModel;
  /** Starts best-effort diagnostics after the provider request is invoked. */
  readonly startToolCacheFingerprintReport?: () => void;
  readonly toolChoice?: PreparedModelToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export async function resolveModelStepOptions({
  alwaysActiveTools = [],
  attemptId,
  diagnostics,
  history,
  model,
  prepareModelStep,
  runtimeStepIndex,
  signal,
  threadKey,
  toolChoice,
  toolOrder = [],
  tools,
}: ResolveModelStepOptions): Promise<ResolvedModelStepOptions> {
  const registry = copyToolRegistry(tools);
  const registryNames = Object.keys(registry ?? {});
  const registrySet = new Set(registryNames);
  const alwaysActiveToolSnapshot = snapshotToolNames(
    alwaysActiveTools,
    "alwaysActiveTools",
    registryNames.length
  );
  const toolOrderSnapshot = snapshotToolNames(
    toolOrder,
    "toolOrder",
    registryNames.length
  );
  validateToolNames(alwaysActiveToolSnapshot, "alwaysActiveTools", registrySet);
  validateToolNames(toolOrderSnapshot, "toolOrder", registrySet);

  let preparedResult: unknown;
  let selectionDurationMs = 0;
  if (prepareModelStep) {
    if (threadKey === undefined) {
      throw new ModelToolSelectionError(
        "prepareModelStep requires a runtime threadKey."
      );
    }
    const selectionStarted = performance.now();
    preparedResult = await prepareModelStep({
      history: structuredClone([...history]),
      runtimeStepIndex,
      signal,
      threadKey,
      tools: readonlyToolRegistry(registry),
    });
    selectionDurationMs = Math.max(0, performance.now() - selectionStarted);
  }
  const prepared = parsePrepareModelStepResult(
    preparedResult,
    registryNames.length
  );

  const selectedTools = prepared?.activeTools;
  if (selectedTools !== undefined) {
    validateToolNames(selectedTools, "activeTools", registrySet);
  }

  const alwaysActiveSet = new Set(alwaysActiveToolSnapshot);
  for (const name of selectedTools ?? []) {
    if (alwaysActiveSet.has(name)) {
      throw new ModelToolSelectionError(
        `prepareModelStep activeTools contains always-active tool ${JSON.stringify(name)}.`
      );
    }
  }

  const canonicalRegistryOrder = canonicalToolOrder(
    registryNames,
    toolOrderSnapshot
  );
  const selectedSet = new Set(
    selectedTools ??
      canonicalRegistryOrder.filter((name) => !alwaysActiveSet.has(name))
  );
  const activeTools = [
    ...canonicalRegistryOrder.filter((name) => alwaysActiveSet.has(name)),
    ...canonicalRegistryOrder.filter((name) => selectedSet.has(name)),
  ];
  const executableTools = registry
    ? Object.fromEntries(activeTools.map((name) => [name, registry[name]]))
    : undefined;
  const effectiveToolChoice = snapshotToolChoice(
    prepared?.toolChoice === undefined ? toolChoice : prepared.toolChoice
  ) as PreparedModelToolChoice | undefined;
  validateToolChoice(effectiveToolChoice, registrySet, new Set(activeTools));
  const resolvedModel = prepared?.model ?? model;

  const startToolCacheFingerprintReport = prepareToolCacheFingerprintReport(
    diagnostics,
    {
      activeTools,
      activeToolRegistry: executableTools ?? {},
      alwaysActiveToolCount: alwaysActiveToolSnapshot.length,
      attemptId,
      model: resolvedModel,
      registryNames,
      runtimeStepIndex,
      selectionDurationMs,
    }
  );

  return {
    ...(executableTools === undefined ? {} : { tools: executableTools }),
    ...(registryNames.length === 0
      ? {}
      : { activeTools, toolOrder: activeTools }),
    model: resolvedModel,
    ...(effectiveToolChoice === undefined
      ? {}
      : { toolChoice: effectiveToolChoice }),
    ...(startToolCacheFingerprintReport === undefined
      ? {}
      : { startToolCacheFingerprintReport }),
  };
}

function prepareToolCacheFingerprintReport(
  diagnostics: RuntimeDiagnosticsSink | undefined,
  input: Parameters<typeof reportToolCacheFingerprint>[1]
): (() => void) | undefined {
  if (!diagnostics || diagnostics === noopRuntimeDiagnostics) {
    return;
  }
  let snapshot: Parameters<typeof reportToolCacheFingerprint>[1];
  try {
    snapshot = {
      ...input,
      activeToolRegistry: diagnosticToolRegistry(input.activeToolRegistry),
    };
  } catch {
    return;
  }
  let started = false;
  return () => {
    if (started) {
      return;
    }
    started = true;
    queueMicrotask(() => {
      reportToolCacheFingerprint(diagnostics, snapshot).catch(() => undefined);
    });
  };
}

function parsePrepareModelStepResult(
  value: unknown,
  registeredToolCount: number
): PrepareModelStepResult | undefined {
  if (value === undefined) {
    return;
  }
  if (!isPlainRecord(value)) {
    throw new ModelToolSelectionError(
      "prepareModelStep must return a plain object or undefined."
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !PREPARED_RESULT_KEYS.has(key)) {
      throw new ModelToolSelectionError(
        `prepareModelStep returned unsupported field ${JSON.stringify(String(key))}.`
      );
    }
  }
  const activeTools = ownDataProperty(value, "activeTools", "prepareModelStep");
  const model = ownDataProperty(value, "model", "prepareModelStep");
  const toolChoice = ownDataProperty(value, "toolChoice", "prepareModelStep");
  if (activeTools !== undefined && !Array.isArray(activeTools)) {
    throw new ModelToolSelectionError(
      "prepareModelStep activeTools must be an array of tool names."
    );
  }
  const activeToolSnapshot =
    activeTools === undefined
      ? undefined
      : snapshotToolNames(
          activeTools,
          "prepareModelStep activeTools",
          registeredToolCount
        );
  if (model !== undefined && !isLanguageModelObject(model)) {
    throw new ModelToolSelectionError(
      "prepareModelStep model must implement an AI SDK v2, v3, or v4 language model."
    );
  }
  return {
    ...(activeToolSnapshot === undefined
      ? {}
      : { activeTools: activeToolSnapshot }),
    ...(model === undefined ? {} : { model }),
    ...(toolChoice === undefined
      ? {}
      : {
          toolChoice: snapshotToolChoice(toolChoice) as PreparedModelToolChoice,
        }),
  };
}

function snapshotToolNames(
  value: unknown,
  context: string,
  maximumLength: number
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ModelToolSelectionError(
      `${context} must be an array of tool names.`
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !(
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0 &&
      lengthDescriptor.value <= maximumLength
    )
  ) {
    throw new ModelToolSelectionError(`${context} has an invalid length.`);
  }
  const snapshot: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor)) {
      throw new ModelToolSelectionError(
        `${context} must be a dense array of data-property tool names.`
      );
    }
    if (typeof descriptor.value !== "string") {
      throw new ModelToolSelectionError(
        `${context} must contain only tool-name strings.`
      );
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function snapshotToolChoice(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return value;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new ModelToolSelectionError(
        "toolChoice must contain only named string fields."
      );
    }
    snapshot[key] = ownDataProperty(value, key, "toolChoice");
  }
  return Object.freeze(snapshot);
}

function readonlyToolRegistry(
  registry: ToolSet | undefined
): Readonly<ToolSet> {
  return Object.freeze(
    Object.fromEntries(
      Object.keys(registry ?? {}).map((name) => [
        name,
        readonlyToolFacade((registry as ToolSet)[name]),
      ])
    )
  );
}

function readonlyToolFacade(definition: ToolSet[string]): ToolSet[string] {
  const facade: Record<string, unknown> = Object.create(null);
  copyEnumerableDataProperties(definition, facade, new WeakMap());
  return Object.freeze(facade) as ToolSet[string];
}

function readonlyNestedSnapshot(
  value: unknown,
  seen = new WeakMap<object, unknown>()
): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (typeof value === "function") {
    const blocked = function readonlyToolCallback(): never {
      throw new ModelToolSelectionError(
        "prepareModelStep tool facades do not expose callable members."
      );
    };
    seen.set(value, blocked);
    copyEnumerableDataProperties(value, blocked, seen);
    return Object.freeze(blocked);
  }
  const snapshot: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : Object.create(null);
  seen.set(value, snapshot);
  copyEnumerableDataProperties(value, snapshot, seen);
  return Object.freeze(snapshot);
}

function copyToolRegistry(tools: ToolSet | undefined): ToolSet | undefined {
  if (tools === undefined) {
    return;
  }
  const registry: ToolSet = Object.create(null);
  for (const name of Object.keys(tools)) {
    const descriptor = Object.getOwnPropertyDescriptor(tools, name);
    if (!(descriptor && "value" in descriptor)) {
      throw new ModelToolSelectionError(
        `tools registry entry ${JSON.stringify(name)} must be a data property.`
      );
    }
    registry[name] = descriptor.value as ToolSet[string];
  }
  return registry;
}

function copyEnumerableDataProperties(
  source: object,
  target: object,
  seen: WeakMap<object, unknown>
): void {
  for (const key of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!(descriptor && "value" in descriptor)) {
      continue;
    }
    const targetDescriptor = Object.getOwnPropertyDescriptor(target, key);
    if (targetDescriptor && !targetDescriptor.configurable) {
      continue;
    }
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: readonlyNestedSnapshot(descriptor.value, seen),
      writable: true,
    });
  }
}

function isLanguageModelObject(
  value: unknown
): value is Exclude<LanguageModel, string> {
  if (!isObjectRecord(value) || Array.isArray(value)) {
    return false;
  }
  const specificationVersion = dataPropertyInPrototypeChain(
    value,
    "specificationVersion"
  );
  const provider = propertyDescriptorInPrototypeChain(value, "provider");
  const modelId = dataPropertyInPrototypeChain(value, "modelId");
  const supportedUrls = propertyDescriptorInPrototypeChain(
    value,
    "supportedUrls"
  );
  const doGenerate = dataPropertyInPrototypeChain(value, "doGenerate");
  const doStream = dataPropertyInPrototypeChain(value, "doStream");
  return (
    (specificationVersion === "v2" ||
      specificationVersion === "v3" ||
      specificationVersion === "v4") &&
    propertyCanProvideValue(provider, "string") &&
    typeof modelId === "string" &&
    propertyCanProvideValue(supportedUrls) &&
    typeof doGenerate === "function" &&
    typeof doStream === "function"
  );
}

const MISSING_DATA_PROPERTY = Symbol("missing-data-property");

function propertyDescriptorInPrototypeChain(
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

function propertyCanProvideValue(
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

function dataPropertyInPrototypeChain(
  value: object,
  property: string
): unknown | typeof MISSING_DATA_PROPERTY {
  const descriptor = propertyDescriptorInPrototypeChain(value, property);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : MISSING_DATA_PROPERTY;
}

function canonicalToolOrder(
  registryNames: readonly string[],
  configuredOrder: readonly string[]
): string[] {
  const configured = new Set(configuredOrder);
  return [
    ...configuredOrder,
    ...registryNames
      .filter((name) => !configured.has(name))
      .sort(compareToolNames),
  ];
}

function compareToolNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateToolChoice(
  toolChoice: PreparedModelToolChoice | undefined,
  registry: ReadonlySet<string>,
  activeTools: ReadonlySet<string>
): void {
  if (
    toolChoice === undefined ||
    toolChoice === "auto" ||
    toolChoice === "none"
  ) {
    return;
  }
  if (toolChoice === "required" && activeTools.size === 0) {
    throw new ModelToolSelectionError(
      'toolChoice "required" cannot be used without an active tool.'
    );
  }
  if (toolChoice === "required") {
    return;
  }
  if (
    !isPlainRecord(toolChoice) ||
    ownProperty(toolChoice, "type") !== "tool"
  ) {
    throw new ModelToolSelectionError(
      'toolChoice must be "auto", "none", "required", or a named tool selection.'
    );
  }
  if (
    Reflect.ownKeys(toolChoice).some(
      (key) => typeof key !== "string" || (key !== "type" && key !== "toolName")
    )
  ) {
    throw new ModelToolSelectionError(
      "named toolChoice may contain only type and toolName."
    );
  }
  const name = ownProperty(toolChoice, "toolName");
  if (typeof name !== "string" || !registry.has(name)) {
    throw new ModelToolSelectionError(
      `toolChoice references unknown tool ${JSON.stringify(name)}.`
    );
  }
  if (!activeTools.has(name)) {
    throw new ModelToolSelectionError(
      `toolChoice references inactive tool ${JSON.stringify(name)}.`
    );
  }
}

function validateToolNames(
  names: readonly string[],
  field: string,
  registry: ReadonlySet<string>
): void {
  if (!Array.isArray(names)) {
    throw new ModelToolSelectionError(
      `${field} must be an array of tool names.`
    );
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") {
      throw new ModelToolSelectionError(`${field} must contain only strings.`);
    }
    if (seen.has(name)) {
      throw new ModelToolSelectionError(
        `${field} contains duplicate tool ${JSON.stringify(name)}.`
      );
    }
    if (!registry.has(name)) {
      throw new ModelToolSelectionError(
        `${field} references unknown tool ${JSON.stringify(name)}.`
      );
    }
    seen.add(name);
  }
}

async function reportToolCacheFingerprint(
  diagnostics: RuntimeDiagnosticsSink | undefined,
  input: {
    readonly activeTools: readonly string[];
    readonly activeToolRegistry: ToolSet;
    readonly alwaysActiveToolCount: number;
    readonly attemptId: string;
    readonly model: LanguageModel;
    readonly registryNames: readonly string[];
    readonly runtimeStepIndex: number;
    readonly selectionDurationMs: number;
  }
): Promise<void> {
  if (!diagnostics || diagnostics === noopRuntimeDiagnostics) {
    return;
  }
  try {
    const [
      activeToolsFingerprint,
      modelIdentity,
      orderedToolNamesFingerprint,
      semanticFingerprint,
      registryToolNamesFingerprint,
    ] = await Promise.all([
      toolNamesFingerprint([...input.activeTools].sort(compareToolNames)),
      fingerprintModelIdentity(input.model),
      toolNamesFingerprint(input.activeTools),
      toolSemanticFingerprint(input.activeTools, input.activeToolRegistry),
      toolNamesFingerprint([...input.registryNames].sort(compareToolNames)),
    ]);
    const metadata: ModelToolCacheFingerprintMetadata = {
      activeToolCount: input.activeTools.length,
      activeToolsFingerprint,
      alwaysActiveToolCount: input.alwaysActiveToolCount,
      attemptId: input.attemptId,
      dynamicDescriptionToolCount: countDynamicDescriptions(
        input.activeTools,
        input.activeToolRegistry
      ),
      modelIdentityFingerprint: modelIdentity.fingerprint,
      modelIdentityFingerprintUnavailable: modelIdentity.unavailable,
      orderedToolNamesFingerprint,
      orderedToolSemanticFingerprint: semanticFingerprint.fingerprint,
      registeredToolCount: input.registryNames.length,
      registryToolNamesFingerprint,
      runtimeStepIndex: input.runtimeStepIndex,
      selectionDurationMs: input.selectionDurationMs,
      semanticFingerprintUnavailableToolCount:
        semanticFingerprint.unavailableToolCount,
      toolLoadingStrategy: "eager-active-tools",
    };
    await diagnostics.report({
      code: "model.tool_cache_fingerprint",
      level: "info",
      metadata,
      phase: "model-step",
    });
  } catch {
    // Diagnostics must never make a model step fail.
  }
}

async function fingerprintModelIdentity(model: LanguageModel): Promise<{
  readonly fingerprint: string;
  readonly unavailable: boolean;
}> {
  if (typeof model === "string") {
    return {
      fingerprint: await jsonFingerprint(["gateway", model]),
      unavailable: false,
    };
  }
  const specificationVersion = dataPropertyInPrototypeChain(
    model,
    "specificationVersion"
  );
  const provider = dataPropertyInPrototypeChain(model, "provider");
  const modelId = dataPropertyInPrototypeChain(model, "modelId");
  const unavailable = !(
    (specificationVersion === "v2" ||
      specificationVersion === "v3" ||
      specificationVersion === "v4") &&
    typeof provider === "string" &&
    typeof modelId === "string"
  );
  return {
    fingerprint: await jsonFingerprint([
      "model",
      specificationVersion === MISSING_DATA_PROPERTY
        ? { status: "unavailable" }
        : specificationVersion,
      provider === MISSING_DATA_PROPERTY ? { status: "unavailable" } : provider,
      modelId === MISSING_DATA_PROPERTY ? { status: "unavailable" } : modelId,
    ]),
    unavailable,
  };
}

function diagnosticToolRegistry(tools: ToolSet): ToolSet {
  const snapshot: ToolSet = Object.create(null);
  for (const name of Object.keys(tools)) {
    try {
      const tool = tools[name];
      if (!isObjectRecord(tool)) {
        snapshot[name] = tool;
        continue;
      }
      const definition: Record<PropertyKey, unknown> = Object.create(null);
      if (!isPlainRecord(tool)) {
        markSemanticToolUnavailable(definition);
      }
      for (const field of SEMANTIC_TOOL_FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(tool, field);
        if (descriptor) {
          Object.defineProperty(definition, field, descriptor);
        }
      }
      snapshot[name] = Object.freeze(definition) as ToolSet[string];
    } catch {
      const unavailable: Record<PropertyKey, unknown> = Object.create(null);
      markSemanticToolUnavailable(unavailable);
      snapshot[name] = Object.freeze(unavailable) as ToolSet[string];
    }
  }
  return Object.freeze(snapshot);
}

function markSemanticToolUnavailable(
  definition: Record<PropertyKey, unknown>
): void {
  Object.defineProperty(definition, SEMANTIC_TOOL_UNAVAILABLE, { value: true });
}

async function toolSemanticFingerprint(
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

function snapshotInputSchema(
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
    // Use the intrinsic directly: genuine promises get a rejection observer,
    // while hostile thenables fail the brand check without invoking `then`.
    Promise.prototype.then.call(value, undefined, () => undefined);
    return true;
  } catch {
    // Non-native thenables remain unavailable and are never assimilated.
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

type SafeDataProperty =
  | { readonly status: "accessor" }
  | { readonly status: "data"; readonly value: unknown }
  | { readonly status: "missing" };

function safeOwnDataProperty(
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

function dataPropertyValue(property: SafeDataProperty): unknown {
  return property.status === "data" ? property.value : undefined;
}

function fingerprintValueIsSafe(
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

function countDynamicDescriptions(
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

function canonicalFingerprintValue(
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

function toolNamesFingerprint(names: readonly string[]): Promise<string> {
  return jsonFingerprint(names);
}

async function jsonFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectRecord(value) || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownProperty(
  value: Record<string, unknown>,
  property: string
): unknown {
  return Object.hasOwn(value, property) ? value[property] : undefined;
}

function ownDataProperty(
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
