import type { LanguageModel, ModelMessage, ToolChoice, ToolSet } from "ai";
import {
  type ModelToolCacheFingerprintMetadata,
  noopRuntimeDiagnostics,
  type RuntimeDiagnosticsSink,
} from "../plugins/diagnostics";

export type PreparedModelToolChoice = ToolChoice<ToolSet>;

export interface PrepareModelStepInput {
  readonly history: readonly ModelMessage[];
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

export class ModelToolSelectionError extends TypeError {
  readonly name = "ModelToolSelectionError";
}

export interface ResolveModelStepOptions {
  readonly alwaysActiveTools?: readonly string[];
  readonly diagnostics?: RuntimeDiagnosticsSink;
  readonly history: readonly ModelMessage[];
  readonly model: LanguageModel;
  readonly prepareModelStep?: PrepareModelStep;
  readonly runtimeStepIndex: number;
  readonly signal: AbortSignal;
  readonly threadKey: string;
  readonly toolChoice?: PreparedModelToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export interface ResolvedModelStepOptions {
  readonly activeTools?: readonly string[];
  readonly model: LanguageModel;
  readonly toolChoice?: PreparedModelToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export async function resolveModelStepOptions({
  alwaysActiveTools = [],
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
  const registry = tools ? { ...tools } : undefined;
  const registryNames = Object.keys(registry ?? {});
  const registrySet = new Set(registryNames);
  validateToolNames(alwaysActiveTools, "alwaysActiveTools", registrySet);
  validateToolNames(toolOrder, "toolOrder", registrySet);

  const preparedResult: unknown = prepareModelStep
    ? await prepareModelStep({
        history: [...history],
        runtimeStepIndex,
        signal,
        threadKey,
        tools: Object.freeze({ ...(registry ?? {}) }),
      })
    : undefined;
  assertPrepareModelStepResult(preparedResult);
  const prepared = preparedResult;

  const selectedTools = prepared?.activeTools;
  if (selectedTools !== undefined) {
    validateToolNames(selectedTools, "activeTools", registrySet);
  }

  const alwaysActiveSet = new Set(alwaysActiveTools);
  for (const name of selectedTools ?? []) {
    if (alwaysActiveSet.has(name)) {
      throw new ModelToolSelectionError(
        `prepareModelStep activeTools contains always-active tool ${JSON.stringify(name)}.`
      );
    }
  }

  const canonicalRegistryOrder = canonicalToolOrder(registryNames, toolOrder);
  const selectedSet = new Set(
    selectedTools ??
      canonicalRegistryOrder.filter((name) => !alwaysActiveSet.has(name))
  );
  const activeTools = [
    ...canonicalRegistryOrder.filter((name) => alwaysActiveSet.has(name)),
    ...canonicalRegistryOrder.filter((name) => selectedSet.has(name)),
  ];
  const effectiveToolChoice = prepared?.toolChoice ?? toolChoice;
  validateToolChoice(effectiveToolChoice, registrySet, new Set(activeTools));

  const pendingDiagnostic = reportToolCacheFingerprint(diagnostics, {
    activeTools,
    alwaysActiveToolCount: alwaysActiveTools.length,
    registryNames,
    runtimeStepIndex,
  });
  pendingDiagnostic.catch(() => undefined);

  return {
    ...(registry === undefined ? {} : { tools: registry }),
    ...(registryNames.length === 0
      ? {}
      : { activeTools, toolOrder: activeTools }),
    model: prepared?.model ?? model,
    ...(effectiveToolChoice === undefined
      ? {}
      : { toolChoice: effectiveToolChoice }),
  };
}

function assertPrepareModelStepResult(
  value: unknown
): asserts value is PrepareModelStepResult | undefined {
  if (value === undefined) {
    return;
  }
  if (!isObjectRecord(value) || Array.isArray(value)) {
    throw new ModelToolSelectionError(
      "prepareModelStep must return an object or undefined."
    );
  }
  if (value.activeTools !== undefined && !Array.isArray(value.activeTools)) {
    throw new ModelToolSelectionError(
      "prepareModelStep activeTools must be an array of tool names."
    );
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== "object" ||
      value.model === null ||
      Array.isArray(value.model))
  ) {
    throw new ModelToolSelectionError(
      "prepareModelStep model must be a language model object."
    );
  }
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
  if (!(isObjectRecord(toolChoice) && toolChoice.type === "tool")) {
    return;
  }
  const name = toolChoice.toolName;
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
    readonly alwaysActiveToolCount: number;
    readonly registryNames: readonly string[];
    readonly runtimeStepIndex: number;
  }
): Promise<void> {
  if (!diagnostics || diagnostics === noopRuntimeDiagnostics) {
    return;
  }
  try {
    const [
      activeToolsFingerprint,
      orderedToolNamesFingerprint,
      registryToolNamesFingerprint,
    ] = await Promise.all([
      toolNamesFingerprint([...input.activeTools].sort(compareToolNames)),
      toolNamesFingerprint(input.activeTools),
      toolNamesFingerprint([...input.registryNames].sort(compareToolNames)),
    ]);
    const metadata: ModelToolCacheFingerprintMetadata = {
      activeToolCount: input.activeTools.length,
      activeToolsFingerprint,
      alwaysActiveToolCount: input.alwaysActiveToolCount,
      orderedToolNamesFingerprint,
      registeredToolCount: input.registryNames.length,
      registryToolNamesFingerprint,
      runtimeStepIndex: input.runtimeStepIndex,
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

async function toolNamesFingerprint(names: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(names));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
