import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_BASE_URL = "https://freerouter.minpeter.workers.dev/v1";
const DEFAULT_MODELS = [
  "minimaxai/minimax-m2.7",
  "mistralai/ministral-14b-latest",
  "qwen/qwen2.5-7b-instruct",
] as const;
const DEFAULT_OUTPUT = "benchmarks/cache-stable-tools/latest-freerouter.json";
const FIXED_TOOL_NAMES = [
  "runtime_status",
  "read_project_file",
  "list_project_files",
  "search_project_text",
] as const;
const DYNAMIC_TOOL_NAMES = [
  "query_issue_tracker",
  "query_release_notes",
  "query_session_memory",
  "query_dependency_docs",
] as const;
const ALL_TOOL_NAMES = [...FIXED_TOOL_NAMES, ...DYNAMIC_TOOL_NAMES];
const SAFE_ERROR_CODE_PATTERN = /^[\w.-]{1,80}$/u;
const TRAILING_SLASH_PATTERN = /\/$/u;

type CacheReporting =
  | "not-reported"
  | "reported-nonzero"
  | "reported-zero-only"
  | "unavailable";
type Phase = "measure" | "warmup";
type Scenario = "active-set-change" | "same-set-order";
type Variant =
  | "changed-active-set"
  | "reversed-order"
  | "stable-order"
  | "unchanged-active-set";

interface CliOptions {
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly output: string;
  readonly prefixLines: number;
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly trials: number;
}

interface NumericUsage {
  readonly cacheReadSource: string | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteSource: string | null;
  readonly cacheWriteTokens: number | null;
  readonly inputSource: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly usageNumericFields: Readonly<Record<string, number>>;
}

interface RequestResult extends NumericUsage {
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly phase: Phase;
  readonly requestBodySha256: string;
  readonly scenario: Scenario;
  readonly success: boolean;
  readonly toolsArraySha256: string;
  readonly trial: number;
  readonly variant: Variant;
}

interface ScenarioArm {
  readonly measuredTools: readonly string[];
  readonly variant: Variant;
}

interface ScenarioDefinition {
  readonly arms: readonly [ScenarioArm, ScenarioArm];
  readonly changedVariant: Variant;
  readonly controlVariant: Variant;
  readonly name: Scenario;
  readonly warmupTools: readonly string[];
}

const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    name: "same-set-order",
    warmupTools: ALL_TOOL_NAMES,
    controlVariant: "stable-order",
    changedVariant: "reversed-order",
    arms: [
      { variant: "stable-order", measuredTools: ALL_TOOL_NAMES },
      {
        variant: "reversed-order",
        measuredTools: [...ALL_TOOL_NAMES].reverse(),
      },
    ],
  },
  {
    name: "active-set-change",
    warmupTools: ALL_TOOL_NAMES,
    controlVariant: "unchanged-active-set",
    changedVariant: "changed-active-set",
    arms: [
      { variant: "unchanged-active-set", measuredTools: ALL_TOOL_NAMES },
      {
        variant: "changed-active-set",
        measuredTools: [
          ...FIXED_TOOL_NAMES,
          DYNAMIC_TOOL_NAMES[0],
          DYNAMIC_TOOL_NAMES[1],
        ],
      },
    ],
  },
];

const CACHE_READ_PATHS = [
  "prompt_tokens_details.cached_tokens",
  "input_tokens_details.cached_tokens",
  "prompt_tokens_details.cache_read_tokens",
  "input_tokens_details.cache_read_tokens",
  "cache_read_input_tokens",
  "cache_read_tokens",
  "cached_input_tokens",
] as const;
const CACHE_WRITE_PATHS = [
  "prompt_tokens_details.cache_creation_tokens",
  "input_tokens_details.cache_creation_tokens",
  "cache_creation_input_tokens",
  "cache_write_input_tokens",
  "cache_write_tokens",
] as const;
const INPUT_PATHS = ["prompt_tokens", "input_tokens"] as const;
const OUTPUT_PATHS = ["completion_tokens", "output_tokens"] as const;
const TOTAL_PATHS = ["total_tokens"] as const;

function usage(): never {
  process.stdout.write(`Cache-stable tool benchmark

Required environment:
  CACHE_BENCH_API_KEY       bearer token (never written to results)

Options:
  --base-url <url>          default: ${DEFAULT_BASE_URL}
  --models <id,id,...>      default: ${DEFAULT_MODELS.join(",")}
  --output <path>           default: ${DEFAULT_OUTPUT}
  --prefix-lines <count>    default: 700
  --settle-ms <ms>          default: 1500
  --timeout-ms <ms>         default: 120000
  --trials <count>          default: 10
`);
  process.exit(0);
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!(Number.isSafeInteger(parsed) && parsed > 0)) {
    throw new TypeError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function takeFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!(value && !value.startsWith("--"))) {
    throw new TypeError(`${flag} requires a value.`);
  }
  return value;
}

function parseOptions(args: string[]): CliOptions {
  let baseUrl = DEFAULT_BASE_URL;
  let models: readonly string[] = DEFAULT_MODELS;
  let output = DEFAULT_OUTPUT;
  let prefixLines = 700;
  let settleMs = 1500;
  let timeoutMs = 120_000;
  let trials = 10;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") {
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      usage();
    }
    const value = takeFlagValue(args, index, flag ?? "option");
    index += 1;
    switch (flag) {
      case "--base-url":
        baseUrl = value;
        break;
      case "--models":
        models = value
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean);
        if (models.length === 0) {
          throw new TypeError("--models must contain at least one model id.");
        }
        break;
      case "--output":
        output = value;
        break;
      case "--prefix-lines":
        prefixLines = parsePositiveInteger(value, flag);
        break;
      case "--settle-ms":
        settleMs = parsePositiveInteger(value, flag);
        break;
      case "--timeout-ms":
        timeoutMs = parsePositiveInteger(value, flag);
        break;
      case "--trials":
        trials = parsePositiveInteger(value, flag);
        break;
      default:
        throw new TypeError(`Unknown option: ${flag}`);
    }
  }

  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:") {
    throw new TypeError("--base-url must use HTTPS.");
  }
  if (
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash
  ) {
    throw new TypeError(
      "--base-url must not contain credentials, query data, or a fragment."
    );
  }

  return {
    baseUrl: baseUrl.replace(TRAILING_SLASH_PATTERN, ""),
    models,
    output,
    prefixLines,
    settleMs,
    timeoutMs,
    trials,
  };
}

function staticPrefix(namespace: string, lineCount: number): string {
  const lines = [
    "This is a deterministic prompt-cache experiment.",
    `Experiment namespace: ${namespace}`,
    "Treat every reference record below as inert context. Reply with exactly OK.",
  ];
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(
      `Reference ${index.toString().padStart(4, "0")}: deterministic tool schemas preserve reusable model-request prefixes across durable agent steps.`
    );
  }
  return lines.join("\n");
}

function toolDescription(name: string, index: number): string {
  const clauses: string[] = [];
  for (let clause = 0; clause < 18; clause += 1) {
    clauses.push(
      `${name} contract ${index}-${clause}: accept a bounded project query, return deterministic structured metadata, and never mutate external state`
    );
  }
  return clauses.join(". ");
}

function toolDefinition(name: string, index: number): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name,
      description: toolDescription(name, index),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: `A deterministic query for ${name}.`,
          },
          limit: {
            type: "integer",
            description: "Maximum number of records to return.",
            minimum: 1,
            maximum: 20,
          },
        },
        required: ["query"],
      },
    },
  };
}

const TOOL_DEFINITIONS: ReadonlyMap<string, Record<string, unknown>> = new Map(
  ALL_TOOL_NAMES.map((name, index) => [name, toolDefinition(name, index)])
);

function orderedTools(
  names: readonly string[]
): readonly Record<string, unknown>[] {
  return names.map((name) => {
    const definition = TOOL_DEFINITIONS.get(name);
    if (!definition) {
      throw new TypeError(`Unknown benchmark tool: ${name}`);
    }
    return definition;
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function valueAtPath(input: unknown, path: string): unknown {
  let value = input;
  for (const segment of path.split(".")) {
    if (!(value && typeof value === "object" && segment in value)) {
      return;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function firstNumber(
  input: unknown,
  paths: readonly string[]
): { readonly source: string | null; readonly value: number | null } {
  for (const path of paths) {
    const value = valueAtPath(input, path);
    if (typeof value === "number" && Number.isFinite(value)) {
      return { source: path, value };
    }
  }
  return { source: null, value: null };
}

function numericLeaves(
  value: unknown,
  prefix = "",
  output: Record<string, number> = {}
): Readonly<Record<string, number>> {
  if (typeof value === "number" && Number.isFinite(value)) {
    output[prefix] = value;
    return output;
  }
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    numericLeaves(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function extractUsage(body: unknown): NumericUsage {
  const usageValue =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).usage
      : undefined;
  const cacheRead = firstNumber(usageValue, CACHE_READ_PATHS);
  const cacheWrite = firstNumber(usageValue, CACHE_WRITE_PATHS);
  const input = firstNumber(usageValue, INPUT_PATHS);
  const output = firstNumber(usageValue, OUTPUT_PATHS);
  const total = firstNumber(usageValue, TOTAL_PATHS);
  return {
    cacheReadSource: cacheRead.source,
    cacheReadTokens: cacheRead.value,
    cacheWriteSource: cacheWrite.source,
    cacheWriteTokens: cacheWrite.value,
    inputSource: input.source,
    inputTokens: input.value,
    outputTokens: output.value,
    totalTokens: total.value,
    usageNumericFields: numericLeaves(usageValue),
  };
}

function errorCode(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (error && typeof error === "object") {
      const code = (error as Record<string, unknown>).code;
      if (typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code)) {
        return code;
      }
      const type = (error as Record<string, unknown>).type;
      if (typeof type === "string" && SAFE_ERROR_CODE_PATTERN.test(type)) {
        return type;
      }
    }
  }
  return `http-${status}`;
}

async function runRequest({
  apiKey,
  options,
  model,
  namespace,
  phase,
  scenario,
  toolNames,
  trial,
  variant,
}: {
  readonly apiKey: string;
  readonly model: string;
  readonly namespace: string;
  readonly options: CliOptions;
  readonly phase: Phase;
  readonly scenario: Scenario;
  readonly toolNames: readonly string[];
  readonly trial: number;
  readonly variant: Variant;
}): Promise<RequestResult> {
  const tools = orderedTools(toolNames);
  const requestBody = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: staticPrefix(namespace, options.prefixLines),
      },
      {
        role: "user",
        content: "Reply with exactly OK and do not call a tool.",
      },
    ],
    tools,
    tool_choice: "none",
    max_tokens: 8,
    stream: false,
  });
  const requestBodySha256 = sha256(requestBody);
  const toolsArraySha256 = sha256(JSON.stringify(tools));
  const started = performance.now();
  try {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const extracted = extractUsage(body);
    return {
      ...extracted,
      errorCode: response.ok ? null : errorCode(body, response.status),
      httpStatus: response.status,
      latencyMs: Math.round(performance.now() - started),
      phase,
      requestBodySha256,
      scenario,
      success: response.ok,
      toolsArraySha256,
      trial,
      variant,
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "name" in error
        ? String((error as { readonly name: unknown }).name)
        : "request-error";
    return {
      cacheReadSource: null,
      cacheReadTokens: null,
      cacheWriteSource: null,
      cacheWriteTokens: null,
      errorCode: SAFE_ERROR_CODE_PATTERN.test(code) ? code : "request-error",
      httpStatus: null,
      inputSource: null,
      inputTokens: null,
      latencyMs: Math.round(performance.now() - started),
      outputTokens: null,
      phase,
      requestBodySha256,
      scenario,
      success: false,
      totalTokens: null,
      toolsArraySha256,
      trial,
      usageNumericFields: {},
      variant,
    };
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle);
  if (upper === undefined) {
    return null;
  }
  if (sorted.length % 2 !== 0) {
    return upper;
  }
  const lower = sorted.at(middle - 1);
  if (lower === undefined) {
    return null;
  }
  return (lower + upper) / 2;
}

function variantSummary(requests: readonly RequestResult[]) {
  const measured = requests.filter((request) => request.phase === "measure");
  const successful = measured.filter((request) => request.success);
  const cacheReported = successful.filter(
    (request) => request.cacheReadTokens !== null
  );
  const rates = cacheReported.flatMap((request) =>
    request.inputTokens && request.cacheReadTokens !== null
      ? [request.cacheReadTokens / request.inputTokens]
      : []
  );
  const ratioEligible = cacheReported.filter(
    (request) => request.inputTokens !== null && request.inputTokens > 0
  );
  const cacheReadSum = ratioEligible.reduce(
    (sum, request) => sum + (request.cacheReadTokens ?? 0),
    0
  );
  const inputSum = ratioEligible.reduce(
    (sum, request) => sum + (request.inputTokens ?? 0),
    0
  );
  const cacheReadNonzero = cacheReported.filter(
    (request) => (request.cacheReadTokens ?? 0) > 0
  ).length;
  return {
    attempts: measured.length,
    successes: successful.length,
    cacheReadReported: cacheReported.length,
    cacheReportCoverage:
      successful.length === 0 ? null : cacheReported.length / successful.length,
    cacheReadNonzero,
    cacheReadNonzeroCoverage:
      successful.length === 0 ? null : cacheReadNonzero / successful.length,
    medianCacheReadTokens: median(
      cacheReported.map((request) => request.cacheReadTokens ?? 0)
    ),
    medianCacheReadRatio: median(rates),
    medianInputTokens: median(
      successful.flatMap((request) =>
        request.inputTokens === null ? [] : [request.inputTokens]
      )
    ),
    medianLatencyMs: median(successful.map((request) => request.latencyMs)),
    weightedCacheReadRatio: inputSum === 0 ? null : cacheReadSum / inputSum,
  };
}

function reportingStatus(requests: readonly RequestResult[]): CacheReporting {
  const successful = requests.filter(
    (request) => request.phase === "measure" && request.success
  );
  if (successful.length === 0) {
    return "unavailable";
  }
  const reported = successful.filter(
    (request) => request.cacheReadTokens !== null
  );
  if (reported.length === 0) {
    return "not-reported";
  }
  return reported.some((request) => (request.cacheReadTokens ?? 0) > 0)
    ? "reported-nonzero"
    : "reported-zero-only";
}

function comparisons(requests: readonly RequestResult[]) {
  return SCENARIOS.map(({ changedVariant, controlVariant, name }) => {
    const control = requests.filter(
      (request) =>
        request.phase === "measure" &&
        request.scenario === name &&
        request.variant === controlVariant
    );
    const changed = requests.filter(
      (request) =>
        request.phase === "measure" &&
        request.scenario === name &&
        request.variant === changedVariant
    );
    const paired = control.flatMap((controlRequest) => {
      const changedRequest = changed.find(
        (request) => request.trial === controlRequest.trial
      );
      if (
        !(controlRequest.success && changedRequest?.success) ||
        controlRequest.cacheReadTokens === null ||
        changedRequest.cacheReadTokens === null
      ) {
        return [];
      }
      return [
        {
          trial: controlRequest.trial,
          controlCacheReadTokens: controlRequest.cacheReadTokens,
          changedCacheReadTokens: changedRequest.cacheReadTokens,
          controlMinusChangedCacheReadTokens:
            controlRequest.cacheReadTokens - changedRequest.cacheReadTokens,
          controlLatencyMs: controlRequest.latencyMs,
          changedLatencyMs: changedRequest.latencyMs,
          controlMinusChangedLatencyMs:
            controlRequest.latencyMs - changedRequest.latencyMs,
          controlCacheReadRatio:
            controlRequest.inputTokens &&
            controlRequest.cacheReadTokens !== null
              ? controlRequest.cacheReadTokens / controlRequest.inputTokens
              : null,
          changedCacheReadRatio:
            changedRequest.inputTokens &&
            changedRequest.cacheReadTokens !== null
              ? changedRequest.cacheReadTokens / changedRequest.inputTokens
              : null,
        },
      ];
    });
    return {
      scenario: name,
      controlVariant,
      changedVariant,
      eligiblePairs: paired.length,
      medianControlMinusChangedCacheReadTokens: median(
        paired.map((pair) => pair.controlMinusChangedCacheReadTokens)
      ),
      medianControlMinusChangedLatencyMs: median(
        paired.map((pair) => pair.controlMinusChangedLatencyMs)
      ),
      medianControlMinusChangedCacheReadRatio: median(
        paired.flatMap((pair) =>
          pair.controlCacheReadRatio === null ||
          pair.changedCacheReadRatio === null
            ? []
            : [pair.controlCacheReadRatio - pair.changedCacheReadRatio]
        )
      ),
      pairs: paired,
    };
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const apiKey = process.env.CACHE_BENCH_API_KEY?.trim();
  if (!apiKey) {
    throw new TypeError("CACHE_BENCH_API_KEY is required.");
  }
  const runId = randomUUID();
  const models: Record<string, unknown>[] = [];

  for (const model of options.models) {
    const requests: RequestResult[] = [];
    process.stderr.write(`Benchmarking ${model}\n`);
    for (let trial = 1; trial <= options.trials; trial += 1) {
      for (const scenario of SCENARIOS) {
        for (const arm of scenario.arms) {
          const { variant } = arm;
          const namespace = `${runId}:${model}:${scenario.name}:${variant}:${trial}`;
          const warmup = await runRequest({
            apiKey,
            model,
            namespace,
            options,
            phase: "warmup",
            scenario: scenario.name,
            toolNames: scenario.warmupTools,
            trial,
            variant,
          });
          requests.push(warmup);
          await sleep(options.settleMs);
          const measured = await runRequest({
            apiKey,
            model,
            namespace,
            options,
            phase: "measure",
            scenario: scenario.name,
            toolNames: arm.measuredTools,
            trial,
            variant,
          });
          requests.push(measured);
          process.stderr.write(
            `  trial ${trial} ${scenario.name} ${variant}: ${
              measured.success ? "ok" : measured.errorCode
            }, cache-read=${measured.cacheReadTokens ?? "not-reported"}\n`
          );
        }
      }
    }

    models.push({
      model,
      cacheReporting: reportingStatus(requests),
      summaries: SCENARIOS.flatMap(({ arms, name }) =>
        arms.map(({ variant }) => ({
          scenario: name,
          variant,
          ...variantSummary(
            requests.filter(
              (request) =>
                request.scenario === name && request.variant === variant
            )
          ),
        }))
      ),
      comparisons: comparisons(requests),
      requests,
    });
  }

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    endpoint: options.baseUrl,
    protocol: "openai-chat-completions",
    credentialRecorded: false,
    configuration: {
      models: options.models,
      trials: options.trials,
      prefixLines: options.prefixLines,
      settleMs: options.settleMs,
      timeoutMs: options.timeoutMs,
      fixedToolNames: FIXED_TOOL_NAMES,
      dynamicToolNames: DYNAMIC_TOOL_NAMES,
      armExecutionOrder: {
        mode: "fixed-control-first",
        models: options.models,
        scenarios: SCENARIOS.map((scenario) => scenario.name),
        variantsByScenario: Object.fromEntries(
          SCENARIOS.map((scenario) => [
            scenario.name,
            scenario.arms.map((arm) => arm.variant),
          ])
        ),
        phasesPerArm: ["warmup", "settle", "measure"],
      },
      comparisonSemantics: {
        "same-set-order":
          "The warmup uses canonical order. The measured request either preserves it or reverses the same set.",
        "active-set-change":
          "The warmup uses the full canonical set. The measured request either preserves that set exactly or uses a smaller canonical subset with the fixed prefix intact.",
      },
    },
    interpretation: {
      "not-reported":
        "Successful responses did not expose a recognized cache-read usage field; this does not prove that no provider-side cache exists.",
      "reported-zero-only":
        "A recognized cache-read usage field was exposed, but every measured value was zero.",
      "reported-nonzero":
        "At least one measured response exposed a positive provider-reported cache-read token count.",
      unavailable: "No measured request succeeded.",
    },
    models,
  };

  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stderr.write(`Wrote ${outputPath}\n`);
}

await main();
