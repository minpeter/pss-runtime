import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const DEFAULT_BASE_URL = "https://freerouter.minpeter.workers.dev/v1";
const DEFAULT_MODELS = [
  "minimaxai/minimax-m2.7",
  "minimaxai/minimax-m3",
  "mistralai/ministral-14b-latest",
  "qwen/qwen2.5-7b-instruct",
  "zai-org/glm-4.7",
] as const;
const DEFAULT_OUTPUT = fileURLToPath(
  new URL(
    "../benchmarks/cache-stable-tools/latest-freerouter.json",
    import.meta.url
  )
);
const IMPLEMENTATION_SUPPORT_PATHS = [
  "biome.jsonc",
  "package.json",
  "packages/runtime/package.json",
  "packages/runtime/tsconfig.json",
  "packages/runtime/tsdown.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/benchmark-cache-stable-tools.test.mjs",
  "scripts/cache-stable-tools-evidence.test.mjs",
  "scripts/cache-stable-tools-independent-verifier.adversarial.mjs",
  "scripts/cache-stable-tools-independent-verifier.mjs",
  "scripts/cache-stable-tools-wire.test.mjs",
  "tsconfig.base.json",
  "tsconfig.json",
  "turbo.json",
] as const;
const IMPLEMENTATION_SOURCE_PATHS = await completeImplementationSourcePaths();
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
const MEMBERSHIP_REPLACEMENT_TOOL_NAME = "query_archive_notes";
const ALL_TOOL_NAMES = [...FIXED_TOOL_NAMES, ...DYNAMIC_TOOL_NAMES];
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const SAFE_SEED_PATTERN = /^[\w.-]{1,80}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const TRAILING_SLASH_PATTERN = /\/+$/u;
const BEARER_PATTERN = /Bearer\s/iu;
const KEY_LIKE_PATTERN = /\b(?:fr|sk)-[\w-]{8,}\b/u;
const ACCEPTED_ZERO_TOOL_FINISH_REASONS = ["stop"] as const;
const FINISH_REASON_STATUSES = [
  "accepted-stop",
  "invalid",
  "missing",
  "rejected-content-filter",
  "rejected-function-call",
  "rejected-length",
  "rejected-tool-calls",
] as const;
const BACKEND_METADATA_STATUSES = [
  "absent",
  "hashed",
  "invalid",
  "null",
] as const;
const MAX_MODELS = 20;
const MAX_CHAT_RESPONSE_BYTES = 1_000_000;
const MAX_MODEL_CATALOG_BYTES = 5_000_000;
const MAX_OUTPUT_TOKENS = 256;
const MAX_PREFIX_LINES = 5000;
const MAX_SETTLE_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_TRIALS = 100;
const MIN_TIMEOUT_MS = 1000;
const CONTENT_LENGTH_PATTERN = /^\d+$/u;

type CacheReporting =
  | "not-reported"
  | "reported-nonzero"
  | "reported-zero-only"
  | "unavailable";
type Phase = "measure" | "warmup";
type FinishReasonStatus = (typeof FINISH_REASON_STATUSES)[number];
type BackendMetadataStatus = (typeof BACKEND_METADATA_STATUSES)[number];
type ArmPosition = "first" | "second";
type PairOrder = "changed-first" | "control-first";
type PairMetadataStatus = "matched" | "mismatched" | "unavailable";
type ResponseIdIntegrityStatus =
  | "accepted"
  | "cross-body-duplicate"
  | "duplicate";
type Scenario =
  | "active-set-change"
  | "membership-only-change"
  | "same-set-order";
type Variant =
  | "changed-active-set"
  | "changed-membership"
  | "reversed-order"
  | "stable-order"
  | "unchanged-active-set"
  | "unchanged-membership";

interface CliOptions {
  readonly baseUrl: string;
  readonly campaignId: string | null;
  readonly models: readonly string[];
  readonly output: string;
  readonly prefixLines: number;
  readonly preflightModels: boolean;
  readonly scenarios: readonly ScenarioDefinition[];
  readonly seed: string;
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
  readonly usageFieldAudit: {
    readonly cacheRead: UsageFieldStatus;
    readonly cacheWrite: UsageFieldStatus;
    readonly input: UsageFieldStatus;
    readonly output: UsageFieldStatus;
    readonly total: UsageFieldStatus;
  };
}

type UsageFieldStatus = "absent" | "conflict" | "invalid" | "valid";

interface RequestResult extends NumericUsage {
  readonly armPosition: ArmPosition;
  readonly cacheTelemetryEligible: boolean;
  readonly completedAt: string;
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
  readonly httpSuccess: boolean;
  readonly isolationCanarySha256: string;
  readonly latencyMs: number;
  readonly outputWasExactOk: boolean | null;
  readonly pairOrder: PairOrder;
  readonly phase: Phase;
  readonly requestBodyBytes: number;
  readonly requestBodySha256: string;
  readonly requestSequence: number;
  readonly responseFinishReasonStatuses: readonly FinishReasonStatus[] | null;
  readonly responseIdSha256: string | null;
  readonly responseModel: string | null;
  readonly responseModelMatchesRequested: boolean | null;
  readonly responseToolCallCount: number | null;
  readonly scenario: Scenario;
  readonly serviceTierSha256: string | null;
  readonly serviceTierStatus: BackendMetadataStatus;
  readonly settleElapsedMs: number | null;
  readonly startedAt: string;
  readonly success: boolean;
  readonly systemFingerprintSha256: string | null;
  readonly systemFingerprintStatus: BackendMetadataStatus;
  readonly toolsArrayBytes: number;
  readonly toolsArraySha256: string;
  readonly trial: number;
  readonly variant: Variant;
  readonly warmupPrerequisitePassed: boolean | null;
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

const CORE_SCENARIOS: readonly ScenarioDefinition[] = [
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

const MEMBERSHIP_SCENARIO: ScenarioDefinition = {
  arms: [
    { variant: "unchanged-membership", measuredTools: ALL_TOOL_NAMES },
    {
      variant: "changed-membership",
      measuredTools: ALL_TOOL_NAMES.map((name) =>
        name === DYNAMIC_TOOL_NAMES[1] ? MEMBERSHIP_REPLACEMENT_TOOL_NAME : name
      ),
    },
  ],
  changedVariant: "changed-membership",
  controlVariant: "unchanged-membership",
  name: "membership-only-change",
  warmupTools: ALL_TOOL_NAMES,
};

const ALL_SCENARIOS = [...CORE_SCENARIOS, MEMBERSHIP_SCENARIO] as const;
const ARM_EXECUTION_PHASES = ["warmup", "settle", "measure"] as const;
const PAIR_ORDERS = ["control-first", "changed-first"] as const;
const EVIDENCE_CAMPAIGN = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  id: "pr208-cache-v3-20260717",
  minimumStratumCoverage: 1,
  models: DEFAULT_MODELS,
  prefixLines: 700,
  scenarios: ALL_SCENARIOS,
  seed: "pr208-cache-v3-20260717",
  settleMs: 1500,
  timeoutMs: 120_000,
  trials: 8,
});
const EVIDENCE_CAMPAIGN_CONTROLLED_FLAGS = new Set([
  "--base-url",
  "--models",
  "--output",
  "--prefix-lines",
  "--scenario-set",
  "--seed",
  "--settle-ms",
  "--skip-model-preflight",
  "--timeout-ms",
  "--trials",
]);

function benchmarkRequestTopology({
  models,
  scenarios,
  trials,
}: Pick<CliOptions, "models" | "scenarios" | "trials">) {
  const phasesPerArm = 2;
  const armsPerTrial = scenarios.reduce(
    (sum, scenario) => sum + scenario.arms.length,
    0
  );
  const armsPerModel = trials * armsPerTrial;
  const requestsPerModel = armsPerModel * phasesPerArm;
  return Object.freeze({
    armsPerModel,
    modelCount: models.length,
    orderAssignmentCount: models.length * trials * scenarios.length,
    pairOrderCount: 2,
    phasesPerArm,
    requestsPerModel,
    requestsPerScenario: Object.fromEntries(
      scenarios.map((scenario) => [
        scenario.name,
        trials * scenario.arms.length * phasesPerArm,
      ])
    ),
    scenarioCount: scenarios.length,
    totalRequests: models.length * requestsPerModel,
  });
}

const EVIDENCE_CAMPAIGN_TOPOLOGY = benchmarkRequestTopology(EVIDENCE_CAMPAIGN);

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
  "prompt_tokens_details.cache_write_tokens",
  "input_tokens_details.cache_write_tokens",
  "prompt_tokens_details.cache_creation_tokens",
  "input_tokens_details.cache_creation_tokens",
  "cache_creation_input_tokens",
  "cache_write_input_tokens",
  "cache_write_tokens",
] as const;
const INPUT_PATHS = ["prompt_tokens", "input_tokens"] as const;
const OUTPUT_PATHS = ["completion_tokens", "output_tokens"] as const;
const TOTAL_PATHS = ["total_tokens"] as const;
const execFileAsync = promisify(execFile);

class ResponsePayloadTooLargeError extends Error {
  override readonly name = "response-too-large";
}

function usage(): never {
  process.stdout.write(`Cache-stable tool benchmark

Required environment:
  CACHE_BENCH_API_KEY       bearer token (never written to results)

Options:
  --evidence-campaign      use the verifier-pinned 5-model/3-scenario preset
  --base-url <url>          default: ${DEFAULT_BASE_URL}
  --models <id,id,...>      default: ${DEFAULT_MODELS.join(",")}
  --output <path>           default: ${DEFAULT_OUTPUT}
  --prefix-lines <count>    default: 700
  --scenario-set <name>    core (default), membership-only, or all
  --seed <safe-text>        default: a generated UUID (recorded in results)
  --skip-model-preflight    skip authenticated /models availability check
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

function parseBoundedPositiveInteger(
  value: string | undefined,
  flag: string,
  maximum: number,
  minimum = 1
): number {
  const parsed = parsePositiveInteger(value, flag);
  if (parsed < minimum || parsed > maximum) {
    throw new RangeError(
      `${flag} must be between ${minimum} and ${maximum}, inclusive.`
    );
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

type MutableCliOptions = {
  -readonly [Key in keyof CliOptions]: CliOptions[Key];
};

function parseOptions(args: string[]): CliOptions {
  const options: MutableCliOptions = {
    baseUrl: DEFAULT_BASE_URL,
    campaignId: null,
    models: DEFAULT_MODELS,
    output: DEFAULT_OUTPUT,
    preflightModels: true,
    prefixLines: 700,
    scenarios: CORE_SCENARIOS,
    seed: randomUUID(),
    settleMs: 1500,
    timeoutMs: 120_000,
    trials: 10,
  };
  let evidenceCampaignRequested = false;
  const suppliedFlags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") {
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      usage();
    }
    if (flag === "--evidence-campaign") {
      evidenceCampaignRequested = true;
      continue;
    }
    if (flag === "--skip-model-preflight") {
      options.preflightModels = false;
      suppliedFlags.add(flag);
      continue;
    }
    const value = takeFlagValue(args, index, flag ?? "option");
    index += 1;
    applyOption(options, flag, value);
    if (flag) {
      suppliedFlags.add(flag);
    }
  }

  if (evidenceCampaignRequested) {
    const conflictingFlags = [...suppliedFlags].filter((flag) =>
      EVIDENCE_CAMPAIGN_CONTROLLED_FLAGS.has(flag)
    );
    if (conflictingFlags.length > 0) {
      throw new TypeError(
        `--evidence-campaign cannot be combined with ${conflictingFlags.join(", ")}.`
      );
    }
    options.baseUrl = EVIDENCE_CAMPAIGN.baseUrl;
    options.campaignId = EVIDENCE_CAMPAIGN.id;
    options.models = EVIDENCE_CAMPAIGN.models;
    options.prefixLines = EVIDENCE_CAMPAIGN.prefixLines;
    options.preflightModels = true;
    options.scenarios = EVIDENCE_CAMPAIGN.scenarios;
    options.seed = EVIDENCE_CAMPAIGN.seed;
    options.settleMs = EVIDENCE_CAMPAIGN.settleMs;
    options.timeoutMs = EVIDENCE_CAMPAIGN.timeoutMs;
    options.trials = EVIDENCE_CAMPAIGN.trials;
  }

  const parsedBaseUrl = new URL(options.baseUrl);
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
    ...options,
    baseUrl: options.baseUrl.replace(TRAILING_SLASH_PATTERN, ""),
  };
}

function applyOption(
  options: MutableCliOptions,
  flag: string | undefined,
  value: string
): void {
  switch (flag) {
    case "--base-url":
      options.baseUrl = value;
      return;
    case "--models":
      options.models = parseModels(value);
      return;
    case "--output":
      options.output = value;
      return;
    case "--prefix-lines":
      options.prefixLines = parseBoundedPositiveInteger(
        value,
        flag,
        MAX_PREFIX_LINES
      );
      return;
    case "--seed":
      options.seed = parseSeed(value);
      return;
    case "--scenario-set":
      options.scenarios = parseScenarioSet(value);
      return;
    case "--settle-ms":
      options.settleMs = parseBoundedPositiveInteger(
        value,
        flag,
        MAX_SETTLE_MS
      );
      return;
    case "--timeout-ms":
      options.timeoutMs = parseBoundedPositiveInteger(
        value,
        flag,
        MAX_TIMEOUT_MS,
        MIN_TIMEOUT_MS
      );
      return;
    case "--trials":
      options.trials = parseBoundedPositiveInteger(value, flag, MAX_TRIALS);
      return;
    default:
      throw new TypeError(`Unknown option: ${flag}`);
  }
}

function parseModels(value: string): readonly string[] {
  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0) {
    throw new TypeError("--models must contain at least one model id.");
  }
  if (models.some((model) => !SAFE_MODEL_ID_PATTERN.test(model))) {
    throw new TypeError(
      "--models entries must be 1-200 safe model-id characters."
    );
  }
  if (models.length > MAX_MODELS) {
    throw new RangeError(`--models accepts at most ${MAX_MODELS} ids.`);
  }
  if (new Set(models).size !== models.length) {
    throw new TypeError("--models must not contain duplicate model ids.");
  }
  return models;
}

function parseSeed(value: string): string {
  if (!SAFE_SEED_PATTERN.test(value)) {
    throw new TypeError(
      "--seed must contain 1-80 letters, digits, underscores, dots, or hyphens."
    );
  }
  return value;
}

function parseScenarioSet(value: string): readonly ScenarioDefinition[] {
  if (value === "core") {
    return CORE_SCENARIOS;
  }
  if (value === "membership-only") {
    return [MEMBERSHIP_SCENARIO];
  }
  if (value === "all") {
    return [...CORE_SCENARIOS, MEMBERSHIP_SCENARIO];
  }
  throw new TypeError(
    '--scenario-set must be "core", "membership-only", or "all".'
  );
}

function staticPrefix(namespace: string, lineCount: number): string {
  const lines = [
    "This is a deterministic prompt-cache experiment.",
    `Experiment namespace: ${namespace}`,
    "Treat every reference record and tool as inert. Reply with exactly OK without calling a tool.",
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
      `INERT benchmark schema ${name} ${index}-${clause}: never call this function; it exists only to measure deterministic request-prefix reuse`
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
        properties: {},
      },
    },
  };
}

const TOOL_DEFINITIONS: ReadonlyMap<string, Record<string, unknown>> = new Map([
  ...ALL_TOOL_NAMES.map(
    (name, index) => [name, toolDefinition(name, index)] as const
  ),
  [
    MEMBERSHIP_REPLACEMENT_TOOL_NAME,
    toolDefinition(
      MEMBERSHIP_REPLACEMENT_TOOL_NAME,
      ALL_TOOL_NAMES.indexOf(DYNAMIC_TOOL_NAMES[1])
    ),
  ],
]);

function isolationCanaryDefinition(
  isolationToken: string
): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: `benchmark_canary_${isolationToken}`,
      description: `INERT cache-isolation canary ${isolationToken}: never call this function; its fixed-shape value separates benchmark arms before every other tool definition.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  };
}

function orderedTools(
  names: readonly string[],
  isolationToken: string
): readonly Record<string, unknown>[] {
  return [
    isolationCanaryDefinition(isolationToken),
    ...names.map((name) => {
      const definition = TOOL_DEFINITIONS.get(name);
      if (!definition) {
        throw new TypeError(`Unknown benchmark tool: ${name}`);
      }
      return definition;
    }),
  ];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isolationTokenFor({
  armPosition,
  model,
  runId,
  scenario,
  trial,
}: {
  readonly armPosition: ArmPosition;
  readonly model: string;
  readonly runId: string;
  readonly scenario: Scenario;
  readonly trial: number;
}): string {
  return sha256(
    `${runId}\0${model}\0${scenario}\0${trial}\0${armPosition}`
  ).slice(0, 24);
}

function benchmarkRequestArtifacts({
  isolationToken,
  model,
  namespace,
  prefixLines,
  toolNames,
}: {
  readonly isolationToken: string;
  readonly model: string;
  readonly namespace: string;
  readonly prefixLines: number;
  readonly toolNames: readonly string[];
}) {
  const tools = orderedTools(toolNames, isolationToken);
  const toolsJson = JSON.stringify(tools);
  const requestBody = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: staticPrefix(namespace, prefixLines),
      },
      {
        role: "user",
        content: "Reply with exactly OK and do not call a tool.",
      },
    ],
    tools,
    // Tiny limits are too small for reasoning-capable routes that spend part
    // of the completion budget before emitting the requested two-token text.
    // Keep the response bounded while allowing a normal `stop` finish.
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
  });
  return Object.freeze({
    isolationCanarySha256: sha256(JSON.stringify(tools[0])),
    requestBody,
    requestBodyBytes: Buffer.byteLength(requestBody),
    requestBodySha256: sha256(requestBody),
    toolsArrayBytes: Buffer.byteLength(toolsJson),
    toolsArraySha256: sha256(toolsJson),
  });
}

async function implementationSourceManifest(): Promise<
  Record<(typeof IMPLEMENTATION_SOURCE_PATHS)[number], string>
> {
  const repositoryRoot = new URL("../", import.meta.url);
  const sourcePaths = await completeImplementationSourcePaths();
  return Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        sha256(await readFile(new URL(path, repositoryRoot))),
      ])
    )
  ) as Record<(typeof IMPLEMENTATION_SOURCE_PATHS)[number], string>;
}

async function completeImplementationSourcePaths(): Promise<readonly string[]> {
  const repositoryRoot = new URL("../", import.meta.url);
  const runtimeSources = await regularFilesUnder(
    new URL("packages/runtime/src/", repositoryRoot),
    "packages/runtime/src"
  );
  return [...IMPLEMENTATION_SUPPORT_PATHS, ...runtimeSources].sort();
}

async function regularFilesUnder(
  directory: URL,
  relativeDirectory: string
): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(
        ...(await regularFilesUnder(
          new URL(`${entry.name}/`, directory),
          relativePath
        ))
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Implementation source ${relativePath} is not a file.`);
    }
    paths.push(relativePath);
  }
  return paths;
}

interface BenchmarkSourceSnapshot {
  readonly benchmarkSourceSha256: string;
  readonly implementationSourcesSha256: Record<string, string>;
}

interface RepositoryState {
  readonly commitSha: string;
  readonly worktreeClean: boolean;
}

async function repositoryState(): Promise<RepositoryState> {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const { stdout: commitOutput } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  const { stdout: statusOutput } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  const { stdout: confirmedCommitOutput } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  const commitSha = commitOutput.trim();
  if (
    !GIT_COMMIT_PATTERN.test(commitSha) ||
    confirmedCommitOutput.trim() !== commitSha
  ) {
    throw new Error(
      "Unable to resolve one stable lowercase SHA-1 source-freeze commit."
    );
  }
  return {
    commitSha,
    worktreeClean: statusOutput.length === 0,
  };
}

function assertRepositoryFreeze(
  initial: RepositoryState,
  observed: RepositoryState,
  context: string,
  requireClean: boolean
): void {
  if (observed.commitSha !== initial.commitSha) {
    throw new Error(
      `Source-freeze commit changed ${context}; refusing to write evidence.`
    );
  }
  if (requireClean && !observed.worktreeClean) {
    throw new Error(
      `Evidence campaign worktree became dirty ${context}; refusing to write evidence.`
    );
  }
}

async function benchmarkSourceSnapshot(): Promise<BenchmarkSourceSnapshot> {
  return {
    benchmarkSourceSha256: sha256(
      await readFile(fileURLToPath(import.meta.url))
    ),
    implementationSourcesSha256: await implementationSourceManifest(),
  };
}

async function assertSourceSnapshotMatchesCommit(
  snapshot: BenchmarkSourceSnapshot,
  commitSha: string
): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const expectedHashes = new Map<string, string>([
    [
      "scripts/benchmark-cache-stable-tools.mts",
      snapshot.benchmarkSourceSha256,
    ],
    ...Object.entries(snapshot.implementationSourcesSha256),
  ]);
  for (const [sourcePath, expectedHash] of expectedHashes) {
    try {
      const currentBytes = await readFile(resolve(repositoryRoot, sourcePath));
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${commitSha}:${sourcePath}`],
        {
          cwd: repositoryRoot,
          encoding: null,
          maxBuffer: 20_000_000,
        }
      );
      const frozenBytes = Buffer.isBuffer(stdout)
        ? stdout
        : Buffer.from(stdout);
      if (
        sha256(currentBytes) !== expectedHash ||
        sha256(frozenBytes) !== expectedHash ||
        !currentBytes.equals(frozenBytes)
      ) {
        throw new Error("source bytes differ");
      }
    } catch (error) {
      throw new Error(
        `Implementation source ${sourcePath} does not match source-freeze commit before provider preflight.`,
        { cause: error }
      );
    }
  }
}

function sourceSnapshotsMatch(
  initial: BenchmarkSourceSnapshot,
  final: BenchmarkSourceSnapshot
): boolean {
  if (initial.benchmarkSourceSha256 !== final.benchmarkSourceSha256) {
    return false;
  }
  const initialPaths = Object.keys(initial.implementationSourcesSha256).sort();
  const finalPaths = Object.keys(final.implementationSourcesSha256).sort();
  return (
    initialPaths.length === finalPaths.length &&
    initialPaths.every(
      (path, index) =>
        path === finalPaths[index] &&
        initial.implementationSourcesSha256[path] ===
          final.implementationSourcesSha256[path]
    )
  );
}

function pairOrderFor({
  model,
  scenario,
  seed,
  trial,
}: {
  readonly model: string;
  readonly scenario: Scenario;
  readonly seed: string;
  readonly trial: number;
}): PairOrder {
  const seedStartsControl =
    Number.parseInt(sha256(`${seed}\0${model}\0${scenario}`).slice(0, 8), 16) %
      2 ===
    0;
  const controlFirst = trial % 2 === 1 ? seedStartsControl : !seedStartsControl;
  return controlFirst ? "control-first" : "changed-first";
}

function orderedArms(
  scenario: ScenarioDefinition,
  pairOrder: PairOrder
): readonly [ScenarioArm, ScenarioArm] {
  const control = scenario.arms.find(
    (arm) => arm.variant === scenario.controlVariant
  );
  const changed = scenario.arms.find(
    (arm) => arm.variant === scenario.changedVariant
  );
  if (!(control && changed)) {
    throw new TypeError(
      `Scenario ${scenario.name} is missing a benchmark arm.`
    );
  }
  return pairOrder === "control-first"
    ? [control, changed]
    : [changed, control];
}

function valueAtPath(
  input: unknown,
  path: string
): {
  readonly present: boolean;
  readonly valid: boolean;
  readonly value: unknown;
} {
  let value = input;
  for (const segment of path.split(".")) {
    if (!isPlainRecord(value)) {
      return { present: true, valid: false, value: undefined };
    }
    const property = ownDataProperty(value, segment);
    if (!property.valid) {
      return {
        present: property.present,
        valid: false,
        value: undefined,
      };
    }
    if (!property.present) {
      return { present: false, valid: true, value: undefined };
    }
    value = property.value;
  }
  return { present: true, valid: true, value };
}

function responseChoices(body: unknown): readonly unknown[] | null {
  if (!isPlainRecord(body)) {
    return null;
  }
  const choices = ownDataProperty(body, "choices");
  return choices.valid && choices.present
    ? denseOwnArrayValues(choices.value)
    : null;
}

function denseOwnArrayValues(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lengthProperty = ownDataProperty(value, "length");
  if (
    !(
      lengthProperty.valid &&
      lengthProperty.present &&
      typeof lengthProperty.value === "number" &&
      Number.isSafeInteger(lengthProperty.value) &&
      lengthProperty.value >= 0
    )
  ) {
    return null;
  }
  const length = lengthProperty.value;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = ownDataProperty(value, String(index));
    if (!(item.valid && item.present)) {
      return null;
    }
    result.push(item.value);
  }
  return Object.freeze(result);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!(value !== null && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataProperty(
  value: unknown,
  key: string
): {
  readonly present: boolean;
  readonly valid: boolean;
  readonly value: unknown;
} {
  if (value === null || typeof value !== "object") {
    return { present: false, valid: true, value: undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return { present: false, valid: true, value: undefined };
    }
    if (!("value" in descriptor)) {
      return { present: true, valid: false, value: undefined };
    }
    return { present: true, valid: true, value: descriptor.value };
  } catch {
    return { present: false, valid: false, value: undefined };
  }
}

function ownDataValue(value: unknown, key: string): unknown {
  const property = ownDataProperty(value, key);
  return property.valid && property.present ? property.value : undefined;
}

function auditedNumber(
  input: unknown,
  paths: readonly string[]
): {
  readonly source: string | null;
  readonly status: UsageFieldStatus;
  readonly value: number | null;
} {
  const present = paths.flatMap((path) => {
    const observed = valueAtPath(input, path);
    return observed.present
      ? [{ path, valid: observed.valid, value: observed.value }]
      : [];
  });
  if (present.length === 0) {
    return { source: null, status: "absent", value: null };
  }
  if (
    present.some(
      ({ valid, value }) =>
        !(
          valid &&
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0
        )
    )
  ) {
    return { source: null, status: "invalid", value: null };
  }
  const values = new Set(present.map(({ value }) => value as number));
  if (values.size !== 1) {
    return { source: null, status: "conflict", value: null };
  }
  const selected = present[0];
  return {
    source: selected?.path ?? null,
    status: "valid",
    value: (selected?.value as number | undefined) ?? null,
  };
}

function extractUsage(body: unknown): NumericUsage {
  const usageProperty = isPlainRecord(body)
    ? ownDataProperty(body, "usage")
    : { present: false, valid: true, value: undefined };
  if (
    usageProperty.present &&
    !(usageProperty.valid && isPlainRecord(usageProperty.value))
  ) {
    return invalidUsage();
  }
  const usageValue = usageProperty.present ? usageProperty.value : undefined;
  const cacheRead = auditedNumber(usageValue, CACHE_READ_PATHS);
  const cacheWrite = auditedNumber(usageValue, CACHE_WRITE_PATHS);
  const input = auditedNumber(usageValue, INPUT_PATHS);
  const output = auditedNumber(usageValue, OUTPUT_PATHS);
  const total = auditedNumber(usageValue, TOTAL_PATHS);
  return {
    cacheReadSource: cacheRead.source,
    cacheReadTokens: cacheRead.value,
    cacheWriteSource: cacheWrite.source,
    cacheWriteTokens: cacheWrite.value,
    inputSource: input.source,
    inputTokens: input.value,
    outputTokens: output.value,
    totalTokens: total.value,
    usageFieldAudit: {
      cacheRead: cacheRead.status,
      cacheWrite: cacheWrite.status,
      input: input.status,
      output: output.status,
      total: total.status,
    },
  };
}

function invalidUsage(): NumericUsage {
  return {
    cacheReadSource: null,
    cacheReadTokens: null,
    cacheWriteSource: null,
    cacheWriteTokens: null,
    inputSource: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usageFieldAudit: {
      cacheRead: "invalid",
      cacheWrite: "invalid",
      input: "invalid",
      output: "invalid",
      total: "invalid",
    },
  };
}

function httpErrorCode(status: number): string {
  return `http-${status}`;
}

function localRequestErrorCode(
  error: unknown,
  timeoutSignal: AbortSignal
): string {
  if (timeoutSignal.aborted) {
    return "TimeoutError";
  }
  if (error instanceof ResponsePayloadTooLargeError) {
    return "response-too-large";
  }
  return "request-error";
}

function responseToolCallCount(body: unknown): number | null {
  const choices = responseChoices(body);
  if (choices === null || choices.length === 0) {
    return null;
  }
  let count = 0;
  for (const choice of choices) {
    const choiceCount = responseChoiceToolCallCount(choice);
    if (choiceCount === null) {
      return null;
    }
    const next = count + choiceCount;
    if (!Number.isSafeInteger(next)) {
      return null;
    }
    count = next;
  }
  return count;
}

function responseChoiceToolCallCount(choice: unknown): number | null {
  if (!isPlainRecord(choice)) {
    return null;
  }
  const message = ownDataValue(choice, "message");
  if (!isPlainRecord(message)) {
    return null;
  }
  const toolCallsProperty = ownDataProperty(message, "tool_calls");
  const functionCallProperty = ownDataProperty(message, "function_call");
  if (!(toolCallsProperty.valid && functionCallProperty.valid)) {
    return null;
  }
  const toolCalls = toolCallsProperty.value;
  const denseToolCalls =
    toolCalls == null ? [] : denseOwnArrayValues(toolCalls);
  if (denseToolCalls === null) {
    return null;
  }
  const functionCall = functionCallProperty.value;
  return (
    denseToolCalls.length +
    (functionCall === undefined || functionCall === null ? 0 : 1)
  );
}

function responseFinishReasonStatuses(
  body: unknown
): readonly FinishReasonStatus[] | null {
  const choices = responseChoices(body);
  if (choices === null || choices.length === 0) {
    return null;
  }
  const statuses: FinishReasonStatus[] = [];
  for (const choice of choices) {
    if (!isPlainRecord(choice)) {
      return null;
    }
    const property = ownDataProperty(choice, "finish_reason");
    if (!property.valid) {
      statuses.push("invalid");
      continue;
    }
    if (!property.present || property.value == null) {
      statuses.push("missing");
      continue;
    }
    if (typeof property.value !== "string") {
      statuses.push("invalid");
      continue;
    }
    switch (property.value) {
      case "stop":
        statuses.push("accepted-stop");
        break;
      case "content_filter":
        statuses.push("rejected-content-filter");
        break;
      case "function_call":
        statuses.push("rejected-function-call");
        break;
      case "length":
        statuses.push("rejected-length");
        break;
      case "tool_calls":
        statuses.push("rejected-tool-calls");
        break;
      default:
        statuses.push("invalid");
    }
  }
  return Object.freeze(statuses);
}

function finishReasonsAreAccepted(
  statuses: readonly FinishReasonStatus[] | null
): boolean {
  return (
    statuses !== null &&
    statuses.length > 0 &&
    statuses.every((status) => status === "accepted-stop")
  );
}

function outputWasExactOk(body: unknown): boolean | null {
  const choices = responseChoices(body);
  if (choices === null || choices.length !== 1) {
    return null;
  }
  const choice = choices[0];
  if (!isPlainRecord(choice)) {
    return null;
  }
  const message = ownDataValue(choice, "message");
  const content = ownDataProperty(message, "content");
  if (!(isPlainRecord(message) && content.valid && content.present)) {
    return null;
  }
  return typeof content.value === "string"
    ? content.value.trim() === "OK"
    : null;
}

function responseModel(body: unknown): string | null {
  const model = ownDataValue(body, "model");
  if (!(typeof model === "string" && SAFE_MODEL_ID_PATTERN.test(model))) {
    return null;
  }
  return model;
}

function responseIdSha256(body: unknown): string | null {
  const id = ownDataValue(body, "id");
  return typeof id === "string" && id.length <= 512 ? sha256(id) : null;
}

function sanitizedBackendMetadata(
  body: unknown,
  key: "service_tier" | "system_fingerprint"
): {
  readonly sha256: string | null;
  readonly status: BackendMetadataStatus;
} {
  if (!isPlainRecord(body)) {
    return { sha256: null, status: "absent" };
  }
  const property = ownDataProperty(body, key);
  if (!property.present) {
    return {
      sha256: null,
      status: property.valid ? "absent" : "invalid",
    };
  }
  if (!property.valid) {
    return { sha256: null, status: "invalid" };
  }
  if (property.value === null) {
    return { sha256: null, status: "null" };
  }
  if (
    typeof property.value !== "string" ||
    property.value.length === 0 ||
    property.value.length > 512
  ) {
    return { sha256: null, status: "invalid" };
  }
  return { sha256: sha256(property.value), status: "hashed" };
}

function benchmarkResponseErrorCode({
  finishReasonStatuses,
  outputWasExactOk: exactOutput,
  response,
  toolCallCount,
}: {
  readonly finishReasonStatuses: readonly FinishReasonStatus[] | null;
  readonly outputWasExactOk: boolean | null;
  readonly response: Response;
  readonly toolCallCount: number | null;
}): string | null {
  if (!response.ok) {
    return httpErrorCode(response.status);
  }
  if (toolCallCount === null || finishReasonStatuses === null) {
    return "invalid-response-shape";
  }
  if (toolCallCount > 0) {
    return "unexpected-tool-call";
  }
  if (!finishReasonsAreAccepted(finishReasonStatuses)) {
    return "invalid-finish-reason";
  }
  if (exactOutput === null) {
    return "invalid-response-shape";
  }
  return exactOutput ? null : "unexpected-output";
}

function cacheUsageEnvelopeIsValid(usage: NumericUsage): boolean {
  return (
    usage.usageFieldAudit.input === "valid" &&
    (usage.usageFieldAudit.cacheRead === "absent" ||
      usage.usageFieldAudit.cacheRead === "valid") &&
    (usage.usageFieldAudit.cacheWrite === "absent" ||
      usage.usageFieldAudit.cacheWrite === "valid") &&
    usage.inputTokens !== null &&
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    (usage.cacheReadTokens === null ||
      (Number.isSafeInteger(usage.cacheReadTokens) &&
        usage.cacheReadTokens >= 0)) &&
    (usage.cacheWriteTokens === null ||
      (Number.isSafeInteger(usage.cacheWriteTokens) &&
        usage.cacheWriteTokens >= 0)) &&
    (usage.cacheReadTokens === null ||
      usage.cacheReadTokens <= usage.inputTokens) &&
    (usage.cacheWriteTokens === null ||
      usage.cacheWriteTokens <= usage.inputTokens) &&
    (usage.cacheReadTokens === null ||
      usage.cacheWriteTokens === null ||
      cacheComponentsFitInput(
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.inputTokens
      ))
  );
}

async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && CONTENT_LENGTH_PATTERN.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponsePayloadTooLargeError(
        `Response Content-Length exceeds ${maximumBytes} bytes.`
      );
    }
  }
  if (response.body === null) {
    return;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const chunk = next.value;
      const updatedBytes = totalBytes + chunk.byteLength;
      if (!Number.isSafeInteger(updatedBytes) || updatedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponsePayloadTooLargeError(
          `Response body exceeds ${maximumBytes} bytes.`
        );
      }
      chunks.push(chunk);
      totalBytes = updatedBytes;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        totalBytes
      ).toString("utf8")
    ) as unknown;
  } catch {
    return;
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function runRequest({
  armPosition,
  apiKey,
  isolationToken,
  options,
  model,
  namespace,
  pairOrder,
  phase,
  requestSequence,
  scenario,
  toolNames,
  trial,
  variant,
}: {
  readonly armPosition: ArmPosition;
  readonly apiKey: string;
  readonly isolationToken: string;
  readonly model: string;
  readonly namespace: string;
  readonly options: CliOptions;
  readonly pairOrder: PairOrder;
  readonly phase: Phase;
  readonly requestSequence: number;
  readonly scenario: Scenario;
  readonly toolNames: readonly string[];
  readonly trial: number;
  readonly variant: Variant;
}): Promise<RequestResult> {
  const artifacts = benchmarkRequestArtifacts({
    isolationToken,
    model,
    namespace,
    prefixLines: options.prefixLines,
    toolNames,
  });
  const { requestBody } = artifacts;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
      redirect: "error",
      signal: timeoutSignal,
    });
    const body = response.ok
      ? await readBoundedJsonResponse(response, MAX_CHAT_RESPONSE_BYTES)
      : await cancelResponseBody(response);
    const extracted = extractUsage(body);
    const toolCallCount = responseToolCallCount(body);
    const finishReasonStatuses = responseFinishReasonStatuses(body);
    const exactOutput = outputWasExactOk(body);
    const observedResponseModel = responseModel(body);
    const serviceTier = sanitizedBackendMetadata(body, "service_tier");
    const systemFingerprint = sanitizedBackendMetadata(
      body,
      "system_fingerprint"
    );
    const responseErrorCode = benchmarkResponseErrorCode({
      finishReasonStatuses,
      outputWasExactOk: exactOutput,
      response,
      toolCallCount,
    });
    const success = responseErrorCode === null;
    const modelMatchesRequested =
      observedResponseModel === null ? null : observedResponseModel === model;
    const cacheTelemetryEligible =
      success &&
      modelMatchesRequested === true &&
      cacheUsageEnvelopeIsValid(extracted);
    return {
      ...extracted,
      armPosition,
      cacheTelemetryEligible,
      completedAt: new Date().toISOString(),
      errorCode: responseErrorCode,
      httpStatus: response.status,
      httpSuccess: response.ok,
      isolationCanarySha256: artifacts.isolationCanarySha256,
      latencyMs: Math.round(performance.now() - started),
      outputWasExactOk: exactOutput,
      pairOrder,
      phase,
      requestBodyBytes: artifacts.requestBodyBytes,
      requestBodySha256: artifacts.requestBodySha256,
      requestSequence,
      responseFinishReasonStatuses: finishReasonStatuses,
      responseIdSha256: responseIdSha256(body),
      responseModel: observedResponseModel,
      responseModelMatchesRequested: modelMatchesRequested,
      responseToolCallCount: toolCallCount,
      scenario,
      serviceTierSha256: serviceTier.sha256,
      serviceTierStatus: serviceTier.status,
      settleElapsedMs: null,
      startedAt,
      success,
      systemFingerprintSha256: systemFingerprint.sha256,
      systemFingerprintStatus: systemFingerprint.status,
      toolsArrayBytes: artifacts.toolsArrayBytes,
      toolsArraySha256: artifacts.toolsArraySha256,
      trial,
      variant,
      warmupPrerequisitePassed: null,
    };
  } catch (error) {
    const code = localRequestErrorCode(error, timeoutSignal);
    return {
      armPosition,
      cacheTelemetryEligible: false,
      cacheReadSource: null,
      cacheReadTokens: null,
      cacheWriteSource: null,
      cacheWriteTokens: null,
      completedAt: new Date().toISOString(),
      errorCode: code,
      httpStatus: null,
      httpSuccess: false,
      inputSource: null,
      inputTokens: null,
      isolationCanarySha256: artifacts.isolationCanarySha256,
      latencyMs: Math.round(performance.now() - started),
      outputWasExactOk: null,
      outputTokens: null,
      pairOrder,
      phase,
      requestBodyBytes: artifacts.requestBodyBytes,
      requestBodySha256: artifacts.requestBodySha256,
      requestSequence,
      responseFinishReasonStatuses: null,
      responseIdSha256: null,
      responseModel: null,
      responseModelMatchesRequested: null,
      responseToolCallCount: null,
      scenario,
      serviceTierSha256: null,
      serviceTierStatus: "absent",
      settleElapsedMs: null,
      startedAt,
      success: false,
      systemFingerprintSha256: null,
      systemFingerprintStatus: "absent",
      toolsArrayBytes: artifacts.toolsArrayBytes,
      totalTokens: null,
      toolsArraySha256: artifacts.toolsArraySha256,
      trial,
      usageFieldAudit: {
        cacheRead: "absent",
        cacheWrite: "absent",
        input: "absent",
        output: "absent",
        total: "absent",
      },
      variant,
      warmupPrerequisitePassed: null,
    };
  }
}

function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

function quantile(
  values: readonly number[],
  probability: number
): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    return null;
  }
  const upperWeight = position - lowerIndex;
  return lower * (1 - upperWeight) + upper * upperWeight;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeTokenSum(values: readonly number[], context: string): number {
  let total = 0;
  for (const value of values) {
    if (!isFiniteNonnegative(value)) {
      throw new RangeError(`${context} contains an unsafe token count.`);
    }
    const next = total + value;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(`${context} exceeded the safe integer range.`);
    }
    total = next;
  }
  return total;
}

function cacheComponentsFitInput(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  inputTokens: number
): boolean {
  const total = cacheReadTokens + cacheWriteTokens;
  return Number.isSafeInteger(total) && total <= inputTokens;
}

function safeIntegerDifference(
  left: number,
  right: number,
  context: string
): number {
  if (!(Number.isSafeInteger(left) && Number.isSafeInteger(right))) {
    throw new RangeError(`${context} contains an unsafe integer.`);
  }
  const difference = left - right;
  if (!Number.isSafeInteger(difference)) {
    throw new RangeError(`${context} exceeded the safe integer range.`);
  }
  return difference;
}

function cacheMeasurementIsValid<
  Request extends Pick<
    RequestResult,
    "cacheReadTokens" | "cacheWriteTokens" | "inputTokens" | "usageFieldAudit"
  >,
>(
  request: Request
): request is Request & {
  readonly cacheReadTokens: number;
  readonly inputTokens: number;
} {
  return (
    isFiniteNonnegative(request.inputTokens) &&
    isFiniteNonnegative(request.cacheReadTokens) &&
    request.usageFieldAudit.input === "valid" &&
    request.usageFieldAudit.cacheRead === "valid" &&
    (request.usageFieldAudit.cacheWrite === "absent" ||
      request.usageFieldAudit.cacheWrite === "valid") &&
    request.cacheReadTokens <= request.inputTokens &&
    (request.cacheWriteTokens === null ||
      (isFiniteNonnegative(request.cacheWriteTokens) &&
        request.cacheWriteTokens <= request.inputTokens &&
        cacheComponentsFitInput(
          request.cacheReadTokens,
          request.cacheWriteTokens,
          request.inputTokens
        )))
  );
}

function cacheWriteMeasurementIsValid<
  Request extends Pick<
    RequestResult,
    "cacheReadTokens" | "cacheWriteTokens" | "inputTokens" | "usageFieldAudit"
  >,
>(
  request: Request
): request is Request & {
  readonly cacheWriteTokens: number;
  readonly inputTokens: number;
} {
  return (
    isFiniteNonnegative(request.inputTokens) &&
    isFiniteNonnegative(request.cacheWriteTokens) &&
    request.usageFieldAudit.input === "valid" &&
    request.usageFieldAudit.cacheWrite === "valid" &&
    (request.usageFieldAudit.cacheRead === "absent" ||
      request.usageFieldAudit.cacheRead === "valid") &&
    request.cacheWriteTokens <= request.inputTokens &&
    (request.cacheReadTokens === null ||
      (isFiniteNonnegative(request.cacheReadTokens) &&
        request.cacheReadTokens <= request.inputTokens &&
        cacheComponentsFitInput(
          request.cacheReadTokens,
          request.cacheWriteTokens,
          request.inputTokens
        )))
  );
}

function variantSummary(requests: readonly RequestResult[]) {
  const measured = requests.filter((request) => request.phase === "measure");
  const eligibleRequests = measured.filter(
    (request) => request.cacheTelemetryEligible
  );
  const cacheReported = eligibleRequests.filter(cacheMeasurementIsValid);
  const cacheWriteReported = eligibleRequests.filter(
    cacheWriteMeasurementIsValid
  );
  const rates = cacheReported.flatMap((request) =>
    request.inputTokens && request.cacheReadTokens !== null
      ? [request.cacheReadTokens / request.inputTokens]
      : []
  );
  const ratioEligible = cacheReported.filter(
    (request) => request.inputTokens !== null && request.inputTokens > 0
  );
  const cacheReadSum = safeTokenSum(
    ratioEligible.map((request) => request.cacheReadTokens),
    "weighted cache-read tokens"
  );
  const inputSum = safeTokenSum(
    ratioEligible.map((request) => request.inputTokens),
    "weighted cache-read input tokens"
  );
  const cacheReadNonzero = cacheReported.filter(
    (request) => (request.cacheReadTokens ?? 0) > 0
  ).length;
  const cacheWriteRatioEligible = cacheWriteReported.filter(
    (request) => request.inputTokens > 0
  );
  const cacheWriteSum = safeTokenSum(
    cacheWriteRatioEligible.map((request) => request.cacheWriteTokens),
    "weighted cache-write tokens"
  );
  const cacheWriteInputSum = safeTokenSum(
    cacheWriteRatioEligible.map((request) => request.inputTokens),
    "weighted cache-write input tokens"
  );
  const cacheWriteNonzero = cacheWriteReported.filter(
    (request) => request.cacheWriteTokens > 0
  ).length;
  return {
    attempts: measured.length,
    cacheTelemetryEligible: eligibleRequests.length,
    cacheWriteNonzero,
    cacheWriteNonzeroCoverage:
      eligibleRequests.length === 0
        ? null
        : cacheWriteNonzero / eligibleRequests.length,
    cacheWriteReported: cacheWriteReported.length,
    cacheWriteReportCoverage:
      eligibleRequests.length === 0
        ? null
        : cacheWriteReported.length / eligibleRequests.length,
    cacheWriteRatioEligible: cacheWriteRatioEligible.length,
    cacheWriteRatioCoverage:
      eligibleRequests.length === 0
        ? null
        : cacheWriteRatioEligible.length / eligibleRequests.length,
    captureSuccesses: measured.filter((request) => request.success).length,
    cacheReadReported: cacheReported.length,
    cacheReportCoverage:
      eligibleRequests.length === 0
        ? null
        : cacheReported.length / eligibleRequests.length,
    cacheReadRatioEligible: ratioEligible.length,
    cacheReadRatioCoverage:
      eligibleRequests.length === 0
        ? null
        : ratioEligible.length / eligibleRequests.length,
    cacheReadNonzero,
    cacheReadNonzeroCoverage:
      eligibleRequests.length === 0
        ? null
        : cacheReadNonzero / eligibleRequests.length,
    medianCacheReadTokens: median(
      cacheReported.map((request) => request.cacheReadTokens ?? 0)
    ),
    medianCacheReadRatio: median(rates),
    medianInputTokens: median(
      eligibleRequests.flatMap((request) =>
        isFiniteNonnegative(request.inputTokens) ? [request.inputTokens] : []
      )
    ),
    medianCacheWriteRatio: median(
      cacheWriteRatioEligible.map(
        (request) => request.cacheWriteTokens / request.inputTokens
      )
    ),
    medianCacheWriteTokens: median(
      cacheWriteReported.map((request) => request.cacheWriteTokens)
    ),
    medianLatencyMs: median(
      eligibleRequests.map((request) => request.latencyMs)
    ),
    weightedCacheReadRatio: inputSum === 0 ? null : cacheReadSum / inputSum,
    weightedCacheWriteRatio:
      cacheWriteInputSum === 0 ? null : cacheWriteSum / cacheWriteInputSum,
  };
}

function reportingStatus(requests: readonly RequestResult[]): CacheReporting {
  const successful = requests.filter(
    (request) => request.phase === "measure" && request.cacheTelemetryEligible
  );
  if (successful.length === 0) {
    return "unavailable";
  }
  const reported = successful.filter(cacheMeasurementIsValid);
  if (reported.length === 0) {
    return "not-reported";
  }
  return reported.some((request) => (request.cacheReadTokens ?? 0) > 0)
    ? "reported-nonzero"
    : "reported-zero-only";
}

function cacheWriteReportingStatus(
  requests: readonly RequestResult[]
): CacheReporting {
  const eligible = requests.filter(
    (request) => request.phase === "measure" && request.cacheTelemetryEligible
  );
  if (eligible.length === 0) {
    return "unavailable";
  }
  const reported = eligible.filter(cacheWriteMeasurementIsValid);
  if (reported.length === 0) {
    return "not-reported";
  }
  return reported.some((request) => request.cacheWriteTokens > 0)
    ? "reported-nonzero"
    : "reported-zero-only";
}

function isolationAudit(requests: readonly RequestResult[]) {
  const arms = new Map<string, RequestResult[]>();
  for (const request of requests) {
    const key = `${request.scenario}\0${request.trial}\0${request.variant}`;
    const existing = arms.get(key) ?? [];
    existing.push(request);
    arms.set(key, existing);
  }
  const canaryHashes = [...arms.values()].map(
    (armRequests) => armRequests[0]?.isolationCanarySha256
  );
  const warmups = requests.filter((request) => request.phase === "warmup");
  return {
    armCount: arms.size,
    allArmsHaveOneWarmupAndOneMeasure: [...arms.values()].every(
      (armRequests) =>
        armRequests.length === 2 &&
        armRequests.some((request) => request.phase === "warmup") &&
        armRequests.some((request) => request.phase === "measure")
    ),
    allWarmupMeasurePairsShareCanary: [...arms.values()].every(
      (armRequests) =>
        new Set(armRequests.map((request) => request.isolationCanarySha256))
          .size === 1
    ),
    canariesUniqueAcrossArms:
      canaryHashes.every((hash) => hash !== undefined) &&
      new Set(canaryHashes).size === arms.size,
    uniqueCanaryHashCount: new Set(canaryHashes).size,
    uniqueWarmupToolsArrayHashCount: new Set(
      warmups.map((request) => request.toolsArraySha256)
    ).size,
    uniqueWarmupToolsArrayByteCount: new Set(
      warmups.map((request) => request.toolsArrayBytes)
    ).size,
    membershipChangeIsEqualByteSwap: equalByteMeasurementSwap(
      requests,
      "membership-only-change"
    ),
    sameSetOrderIsEqualByteSwap: equalByteMeasurementSwap(
      requests,
      "same-set-order"
    ),
    slotsCounterbalancedAcrossVariants:
      slotAssignmentsAreCounterbalanced(requests),
    warmupCount: warmups.length,
    unexpectedToolCallResponseCount: requests.filter(
      (request) => (request.responseToolCallCount ?? 0) > 0
    ).length,
  };
}

function slotAssignmentsAreCounterbalanced(
  requests: readonly RequestResult[]
): boolean {
  const measured = requests.filter((request) => request.phase === "measure");
  const scenarioVariants = new Map<Scenario, Set<Variant>>();
  for (const request of measured) {
    const variants = scenarioVariants.get(request.scenario) ?? new Set();
    variants.add(request.variant);
    scenarioVariants.set(request.scenario, variants);
  }
  return [...scenarioVariants.entries()].every(([scenario, variants]) =>
    [...variants].every((variant) => {
      const positions = measured
        .filter(
          (request) =>
            request.scenario === scenario && request.variant === variant
        )
        .map((request) => request.armPosition);
      return (
        positions.filter((position) => position === "first").length ===
        positions.filter((position) => position === "second").length
      );
    })
  );
}

function equalByteMeasurementSwap(
  requests: readonly RequestResult[],
  scenario: Scenario
): boolean | null {
  const measured = requests.filter(
    (request) => request.phase === "measure" && request.scenario === scenario
  );
  if (measured.length === 0) {
    return null;
  }
  const trials = new Set(measured.map((request) => request.trial));
  return [...trials].every((trial) => {
    const trialRequests = measured.filter((request) => request.trial === trial);
    return (
      trialRequests.length === 2 &&
      new Set(trialRequests.map((request) => request.toolsArrayBytes)).size ===
        1 &&
      new Set(trialRequests.map((request) => request.requestBodyBytes)).size ===
        1
    );
  });
}

function responseModelSummary(requests: readonly RequestResult[]) {
  const observed = new Map<string, number>();
  for (const request of requests) {
    if (request.responseModel !== null) {
      observed.set(
        request.responseModel,
        (observed.get(request.responseModel) ?? 0) + 1
      );
    }
  }
  return {
    responses: requests.length,
    modelReported: requests.filter((request) => request.responseModel !== null)
      .length,
    requestedModelMatches: requests.filter(
      (request) => request.responseModelMatchesRequested === true
    ).length,
    requestedModelMismatches: requests.filter(
      (request) => request.responseModelMatchesRequested === false
    ).length,
    requestedModelMissing: requests.filter(
      (request) => request.responseModelMatchesRequested === null
    ).length,
    observedResponseModels: Object.fromEntries(observed),
  };
}

function responseModelAudit(requests: readonly RequestResult[]) {
  return {
    all: responseModelSummary(requests),
    measure: responseModelSummary(
      requests.filter((request) => request.phase === "measure")
    ),
    warmup: responseModelSummary(
      requests.filter((request) => request.phase === "warmup")
    ),
  };
}

function backendMetadataFieldSummary(
  requests: readonly RequestResult[],
  hashField: "serviceTierSha256" | "systemFingerprintSha256",
  statusField: "serviceTierStatus" | "systemFingerprintStatus"
) {
  const hashes = requests.flatMap((request) =>
    request[statusField] === "hashed" && request[hashField] !== null
      ? [request[hashField]]
      : []
  );
  const uniqueHashCount = new Set(hashes).size;
  return {
    statusCounts: Object.fromEntries(
      BACKEND_METADATA_STATUSES.map((status) => [
        status,
        requests.filter((request) => request[statusField] === status).length,
      ])
    ),
    uniqueHashCount,
    driftObserved: uniqueHashCount > 1,
  };
}

function backendMetadataAudit(requests: readonly RequestResult[]) {
  return {
    serviceTier: backendMetadataFieldSummary(
      requests,
      "serviceTierSha256",
      "serviceTierStatus"
    ),
    systemFingerprint: backendMetadataFieldSummary(
      requests,
      "systemFingerprintSha256",
      "systemFingerprintStatus"
    ),
  };
}

function finishReasonSummary(requests: readonly RequestResult[]) {
  const statuses = requests.flatMap(
    (request) => request.responseFinishReasonStatuses ?? []
  );
  return {
    acceptedResponses: requests.filter((request) =>
      finishReasonsAreAccepted(request.responseFinishReasonStatuses)
    ).length,
    choicesAudited: statuses.length,
    responseShapeUnavailable: requests.filter(
      (request) => request.responseFinishReasonStatuses === null
    ).length,
    responses: requests.length,
    statusCounts: Object.fromEntries(
      FINISH_REASON_STATUSES.map((status) => [
        status,
        statuses.filter((observed) => observed === status).length,
      ])
    ),
  };
}

function finishReasonAudit(requests: readonly RequestResult[]) {
  return {
    all: finishReasonSummary(requests),
    measure: finishReasonSummary(
      requests.filter((request) => request.phase === "measure")
    ),
    warmup: finishReasonSummary(
      requests.filter((request) => request.phase === "warmup")
    ),
  };
}

function outputComplianceAudit(requests: readonly RequestResult[]) {
  const summarize = (selected: readonly RequestResult[]) => ({
    exact: selected.filter((request) => request.outputWasExactOk === true)
      .length,
    mismatch: selected.filter((request) => request.outputWasExactOk === false)
      .length,
    unavailable: selected.filter((request) => request.outputWasExactOk === null)
      .length,
  });
  return {
    all: summarize(requests),
    measure: summarize(
      requests.filter((request) => request.phase === "measure")
    ),
    warmup: summarize(requests.filter((request) => request.phase === "warmup")),
  };
}

function requestOutcomeAudit(requests: readonly RequestResult[]) {
  const captureSuccessful = requests.filter((request) => request.success);
  const measured = requests.filter((request) => request.phase === "measure");
  return {
    cacheUsageEnvelopeAudited: captureSuccessful.length,
    cacheUsageEnvelopeUnavailable: requests.length - captureSuccessful.length,
    cacheTelemetryEligible: requests.filter(
      (request) => request.cacheTelemetryEligible
    ).length,
    captureSuccess: requests.filter((request) => request.success).length,
    httpSuccess: requests.filter((request) => request.httpSuccess).length,
    invalidResponseShape: requests.filter(
      (request) => request.errorCode === "invalid-response-shape"
    ).length,
    invalidFinishReason: requests.filter(
      (request) => request.errorCode === "invalid-finish-reason"
    ).length,
    unexpectedOutput: requests.filter(
      (request) => request.errorCode === "unexpected-output"
    ).length,
    measuredCacheTelemetryEligible: measured.filter(
      (request) => request.cacheTelemetryEligible
    ).length,
    measuredLocalCacheTelemetryEligible: measured.filter(
      (request) =>
        request.success &&
        request.responseModelMatchesRequested === true &&
        cacheUsageEnvelopeIsValid(request)
    ).length,
    measuredWarmupPrerequisiteFailures: measured.filter(
      (request) => request.warmupPrerequisitePassed === false
    ).length,
    invalidCacheUsageEnvelope: captureSuccessful.filter(
      (request) => !cacheUsageEnvelopeIsValid(request)
    ).length,
    positiveToolCallResponses: requests.filter(
      (request) => (request.responseToolCallCount ?? 0) > 0
    ).length,
    requests: requests.length,
  };
}

function usageFieldStatusAudit(requests: readonly RequestResult[]) {
  const summarize = (field: keyof NumericUsage["usageFieldAudit"]) =>
    Object.fromEntries(
      (["absent", "valid", "invalid", "conflict"] as const).map((status) => [
        status,
        requests.filter((request) => request.usageFieldAudit[field] === status)
          .length,
      ])
    );
  return {
    cacheRead: summarize("cacheRead"),
    cacheWrite: summarize("cacheWrite"),
    input: summarize("input"),
    output: summarize("output"),
    total: summarize("total"),
  };
}

function membershipInputTokenParityAudit(
  requests: readonly RequestResult[],
  scenario: ScenarioDefinition,
  view: "all-sample" | "primary" = "all-sample",
  providedDuplicateSets?: ReturnType<typeof responseIdDuplicateSets>
) {
  const duplicateSets =
    providedDuplicateSets ?? responseIdDuplicateSets(requests);
  const measured = requests.filter(
    (request) =>
      request.phase === "measure" && request.scenario === scenario.name
  );
  const trials = [...new Set(measured.map((request) => request.trial))].sort(
    (left, right) => left - right
  );
  const pairs = trials.flatMap((trial) => {
    const control = measured.find(
      (request) =>
        request.trial === trial && request.variant === scenario.controlVariant
    );
    const changed = measured.find(
      (request) =>
        request.trial === trial && request.variant === scenario.changedVariant
    );
    if (!(inputParityEligible(control) && inputParityEligible(changed))) {
      return [];
    }
    if (!pairedCoordinatesMatch(control, changed)) {
      return [];
    }
    const fourRequestPair = [
      warmupForMeasurement(requests, control),
      control,
      warmupForMeasurement(requests, changed),
      changed,
    ] as const;
    if (
      view === "primary" &&
      !pairIsPrimaryEligible({
        responseIdStatus: responseIdIntegrityStatus(
          fourRequestPair,
          duplicateSets
        ),
        serviceTierStatus: metadataPairStatus(
          fourRequestPair,
          "serviceTierStatus",
          "serviceTierSha256"
        ),
        systemFingerprintStatus: metadataPairStatus(
          fourRequestPair,
          "systemFingerprintStatus",
          "systemFingerprintSha256"
        ),
      })
    ) {
      return [];
    }
    return [
      {
        changedInputTokens: changed.inputTokens,
        controlInputTokens: control.inputTokens,
        controlMinusChangedInputTokens: safeIntegerDifference(
          control.inputTokens,
          changed.inputTokens,
          "membership input-token difference"
        ),
        pairOrder: control.pairOrder,
        trial,
      },
    ];
  });
  const differences = pairs.map((pair) => pair.controlMinusChangedInputTokens);
  const orderStrata = PAIR_ORDERS.map((pairOrder) => {
    const stratumPairs = pairs.filter((pair) => pair.pairOrder === pairOrder);
    const stratumDifferences = stratumPairs.map(
      (pair) => pair.controlMinusChangedInputTokens
    );
    return {
      pairOrder,
      ...differenceSummary(stratumDifferences),
    };
  });
  const expectedPairsByOrder = Object.fromEntries(
    PAIR_ORDERS.map((pairOrder) => [
      pairOrder,
      measured.filter(
        (request) =>
          request.variant === scenario.controlVariant &&
          request.pairOrder === pairOrder
      ).length,
    ])
  ) as Record<PairOrder, number>;
  return {
    changedHigher: differences.filter((difference) => difference < 0).length,
    controlHigher: differences.filter((difference) => difference > 0).length,
    effectConclusion: directionalEffectConclusion({
      expectedPairsByOrder,
      orderStrata,
    }),
    eligiblePairs: pairs.length,
    equal: differences.filter((difference) => difference === 0).length,
    missingPairs: trials.length - pairs.length,
    orderStrata,
    pairs,
  };
}

function differenceSummary(differences: readonly number[]) {
  return {
    changedHigher: differences.filter((difference) => difference < 0).length,
    controlHigher: differences.filter((difference) => difference > 0).length,
    eligiblePairs: differences.length,
    equal: differences.filter((difference) => difference === 0).length,
    medianDifference: median(differences),
  };
}

function directionalEffectConclusion({
  expectedPairsByOrder,
  orderStrata,
}: {
  readonly expectedPairsByOrder: Readonly<Record<PairOrder, number>>;
  readonly orderStrata: readonly {
    readonly eligiblePairs: number;
    readonly medianDifference: number | null;
    readonly pairOrder: PairOrder;
  }[];
}):
  | "changed-higher"
  | "control-higher"
  | "indeterminate-insufficient-order-stratum-coverage"
  | "no-observed-median-difference"
  | "order-sensitive" {
  if (
    orderStrata.some(({ eligiblePairs, pairOrder }) => {
      const expected = expectedPairsByOrder[pairOrder];
      return (
        expected === 0 ||
        eligiblePairs <
          Math.ceil(expected * EVIDENCE_CAMPAIGN.minimumStratumCoverage)
      );
    })
  ) {
    return "indeterminate-insufficient-order-stratum-coverage";
  }
  const medians = orderStrata.map((stratum) => stratum.medianDifference);
  if (medians.some((value) => value === null)) {
    return "indeterminate-insufficient-order-stratum-coverage";
  }
  const numericMedians = medians as number[];
  if (numericMedians.every((value) => value === 0)) {
    return "no-observed-median-difference";
  }
  if (numericMedians.every((value) => value > 0)) {
    return "control-higher";
  }
  if (numericMedians.every((value) => value < 0)) {
    return "changed-higher";
  }
  return "order-sensitive";
}

function inputParityEligible(
  request: RequestResult | undefined
): request is RequestResult & { readonly inputTokens: number } {
  return Boolean(
    request?.success &&
      request.responseModelMatchesRequested === true &&
      request.warmupPrerequisitePassed === true &&
      request.usageFieldAudit.input === "valid" &&
      isFiniteNonnegative(request.inputTokens)
  );
}

function metadataPairStatus(
  requests: readonly (RequestResult | undefined)[],
  statusField: "serviceTierStatus" | "systemFingerprintStatus",
  hashField: "serviceTierSha256" | "systemFingerprintSha256"
): PairMetadataStatus {
  if (
    requests.some(
      (request) =>
        request?.[statusField] !== "hashed" || request[hashField] === null
    )
  ) {
    return "unavailable";
  }
  return new Set(requests.map((request) => request?.[hashField])).size === 1
    ? "matched"
    : "mismatched";
}

function crossBodyDuplicateResponseIds(
  requests: readonly RequestResult[]
): ReadonlySet<string> {
  const bodiesByResponseId = new Map<string, Set<string>>();
  for (const request of requests) {
    if (request.responseIdSha256 === null) {
      continue;
    }
    const bodies =
      bodiesByResponseId.get(request.responseIdSha256) ?? new Set();
    bodies.add(request.requestBodySha256);
    bodiesByResponseId.set(request.responseIdSha256, bodies);
  }
  return new Set(
    [...bodiesByResponseId.entries()]
      .filter(([, bodies]) => bodies.size > 1)
      .map(([responseId]) => responseId)
  );
}

function duplicateResponseIds(
  requests: readonly RequestResult[]
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const request of requests) {
    if (request.responseIdSha256 !== null) {
      counts.set(
        request.responseIdSha256,
        (counts.get(request.responseIdSha256) ?? 0) + 1
      );
    }
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([responseId]) => responseId)
  );
}

function responseIdDuplicateSets(requests: readonly RequestResult[]) {
  return {
    crossBody: crossBodyDuplicateResponseIds(requests),
    duplicate: duplicateResponseIds(requests),
  };
}

function responseIdAudit(requests: readonly RequestResult[]) {
  const reported = requests.flatMap((request) =>
    request.responseIdSha256 === null ? [] : [request.responseIdSha256]
  );
  const counts = new Map<string, number>();
  for (const responseId of reported) {
    counts.set(responseId, (counts.get(responseId) ?? 0) + 1);
  }
  const crossBodyDuplicates = crossBodyDuplicateResponseIds(requests);
  return {
    reported: reported.length,
    distinct: counts.size,
    duplicateHashes: [...counts.values()].filter((count) => count > 1).length,
    duplicateObservations: [...counts.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0
    ),
    crossRequestBodyDuplicateHashes: crossBodyDuplicates.size,
    crossRequestBodyDuplicateObservations: reported.filter((responseId) =>
      crossBodyDuplicates.has(responseId)
    ).length,
  };
}

function responseIdIntegrityStatus(
  requests: readonly (RequestResult | undefined)[],
  duplicateSets: ReturnType<typeof responseIdDuplicateSets>
): ResponseIdIntegrityStatus {
  const responseIds = requests
    .map((request) => request?.responseIdSha256 ?? null)
    .filter((responseId): responseId is string => responseId !== null);
  if (
    responseIds.some((responseId) => duplicateSets.crossBody.has(responseId))
  ) {
    return "cross-body-duplicate";
  }
  return responseIds.some((responseId) =>
    duplicateSets.duplicate.has(responseId)
  )
    ? "duplicate"
    : "accepted";
}

function pairIsPrimaryEligible({
  responseIdStatus,
  serviceTierStatus,
  systemFingerprintStatus,
}: {
  readonly responseIdStatus: ResponseIdIntegrityStatus;
  readonly serviceTierStatus: PairMetadataStatus;
  readonly systemFingerprintStatus: PairMetadataStatus;
}): boolean {
  return (
    systemFingerprintStatus === "matched" &&
    serviceTierStatus === "matched" &&
    responseIdStatus === "accepted"
  );
}

function warmupForMeasurement(
  requests: readonly RequestResult[],
  measurement: RequestResult
): RequestResult | undefined {
  return requests.find(
    (request) =>
      request.phase === "warmup" &&
      request.scenario === measurement.scenario &&
      request.trial === measurement.trial &&
      request.variant === measurement.variant
  );
}

function comparisons(
  requests: readonly RequestResult[],
  scenarios: readonly ScenarioDefinition[],
  view: "all-sample" | "primary" = "all-sample",
  providedDuplicateSets?: ReturnType<typeof responseIdDuplicateSets>
) {
  const duplicateSets =
    providedDuplicateSets ?? responseIdDuplicateSets(requests);
  return scenarios.map(({ changedVariant, controlVariant, name }) => {
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
        !(
          controlRequest.cacheTelemetryEligible &&
          changedRequest?.cacheTelemetryEligible &&
          cacheMeasurementIsValid(controlRequest) &&
          cacheMeasurementIsValid(changedRequest) &&
          controlRequest.inputTokens > 0 &&
          changedRequest.inputTokens > 0 &&
          pairedCoordinatesMatch(controlRequest, changedRequest)
        )
      ) {
        return [];
      }
      const fourRequestPair = [
        warmupForMeasurement(requests, controlRequest),
        controlRequest,
        warmupForMeasurement(requests, changedRequest),
        changedRequest,
      ] as const;
      const systemFingerprintPairStatus = metadataPairStatus(
        fourRequestPair,
        "systemFingerprintStatus",
        "systemFingerprintSha256"
      );
      const serviceTierPairStatus = metadataPairStatus(
        fourRequestPair,
        "serviceTierStatus",
        "serviceTierSha256"
      );
      const observedResponseIdIntegrityStatus = responseIdIntegrityStatus(
        fourRequestPair,
        duplicateSets
      );
      const pair = {
        pairOrder: controlRequest.pairOrder,
        trial: controlRequest.trial,
        controlCacheReadTokens: controlRequest.cacheReadTokens,
        changedCacheReadTokens: changedRequest.cacheReadTokens,
        controlInputTokens: controlRequest.inputTokens,
        changedInputTokens: changedRequest.inputTokens,
        controlMinusChangedCacheReadTokens: safeIntegerDifference(
          controlRequest.cacheReadTokens,
          changedRequest.cacheReadTokens,
          "paired cache-read-token difference"
        ),
        controlMinusChangedInputTokens: safeIntegerDifference(
          controlRequest.inputTokens,
          changedRequest.inputTokens,
          "paired input-token difference"
        ),
        controlLatencyMs: controlRequest.latencyMs,
        changedLatencyMs: changedRequest.latencyMs,
        controlMinusChangedLatencyMs: safeIntegerDifference(
          controlRequest.latencyMs,
          changedRequest.latencyMs,
          "paired latency difference"
        ),
        controlCacheReadRatio:
          controlRequest.inputTokens && controlRequest.cacheReadTokens !== null
            ? controlRequest.cacheReadTokens / controlRequest.inputTokens
            : null,
        changedCacheReadRatio:
          changedRequest.inputTokens && changedRequest.cacheReadTokens !== null
            ? changedRequest.cacheReadTokens / changedRequest.inputTokens
            : null,
        controlMinusChangedCacheReadRatio:
          controlRequest.cacheReadTokens / controlRequest.inputTokens -
          changedRequest.cacheReadTokens / changedRequest.inputTokens,
        responseIdIntegrityStatus: observedResponseIdIntegrityStatus,
        serviceTierPairStatus,
        systemFingerprintPairStatus,
      };
      if (
        view === "primary" &&
        !pairIsPrimaryEligible({
          responseIdStatus: observedResponseIdIntegrityStatus,
          serviceTierStatus: serviceTierPairStatus,
          systemFingerprintStatus: systemFingerprintPairStatus,
        })
      ) {
        return [];
      }
      return [pair];
    });
    const orderStrata = PAIR_ORDERS.map((pairOrder) => ({
      pairOrder,
      ...pairedSummary(paired.filter((pair) => pair.pairOrder === pairOrder)),
    }));
    const expectedPairsByOrder = Object.fromEntries(
      PAIR_ORDERS.map((pairOrder) => [
        pairOrder,
        control.filter((request) => request.pairOrder === pairOrder).length,
      ])
    ) as Record<PairOrder, number>;
    const cacheReadRatioConclusion = directionalEffectConclusion({
      expectedPairsByOrder,
      orderStrata: orderStrata.map((stratum) => ({
        eligiblePairs: stratum.eligiblePairs,
        medianDifference: stratum.medianControlMinusChangedCacheReadRatioSign,
        pairOrder: stratum.pairOrder,
      })),
    });
    const cacheReadTokenConclusion = directionalEffectConclusion({
      expectedPairsByOrder,
      orderStrata: orderStrata.map((stratum) => ({
        eligiblePairs: stratum.eligiblePairs,
        medianDifference: stratum.medianControlMinusChangedCacheReadTokens,
        pairOrder: stratum.pairOrder,
      })),
    });
    return {
      scenario: name,
      controlVariant,
      changedVariant,
      cacheReadRatioConclusion,
      cacheReadTokenConclusion,
      effectConclusion: endpointCombinedConclusion(
        cacheReadTokenConclusion,
        cacheReadRatioConclusion
      ),
      ...pairedSummary(paired),
      orderStrata,
      pairs: paired,
    };
  });
}

function endpointCombinedConclusion(
  tokenConclusion: ReturnType<typeof directionalEffectConclusion>,
  ratioConclusion: ReturnType<typeof directionalEffectConclusion>
):
  | ReturnType<typeof directionalEffectConclusion>
  | "denominator-sensitive/indeterminate"
  | "endpoint-disagreement/indeterminate" {
  if (tokenConclusion === ratioConclusion) {
    return ratioConclusion;
  }
  if (
    tokenConclusion === "indeterminate-insufficient-order-stratum-coverage" ||
    ratioConclusion === "indeterminate-insufficient-order-stratum-coverage"
  ) {
    return "indeterminate-insufficient-order-stratum-coverage";
  }
  const directional = new Set(["changed-higher", "control-higher"]);
  if (directional.has(tokenConclusion) && directional.has(ratioConclusion)) {
    return "denominator-sensitive/indeterminate";
  }
  return "endpoint-disagreement/indeterminate";
}

function pairedCoordinatesMatch(
  control: RequestResult,
  changed: RequestResult
): boolean {
  if (
    control.trial !== changed.trial ||
    control.scenario !== changed.scenario ||
    control.pairOrder !== changed.pairOrder
  ) {
    return false;
  }
  return control.pairOrder === "control-first"
    ? control.armPosition === "first" && changed.armPosition === "second"
    : control.armPosition === "second" && changed.armPosition === "first";
}

function pairedSummary<
  Pair extends {
    readonly changedCacheReadRatio: number | null;
    readonly changedCacheReadTokens: number;
    readonly changedInputTokens: number;
    readonly controlCacheReadRatio: number | null;
    readonly controlCacheReadTokens: number;
    readonly controlInputTokens: number;
    readonly controlMinusChangedCacheReadRatio: number;
    readonly controlMinusChangedCacheReadTokens: number;
    readonly controlMinusChangedInputTokens: number;
    readonly controlMinusChangedLatencyMs: number;
    readonly responseIdIntegrityStatus: ResponseIdIntegrityStatus;
    readonly serviceTierPairStatus: PairMetadataStatus;
    readonly systemFingerprintPairStatus: PairMetadataStatus;
  },
>(pairs: readonly Pair[]) {
  const tokenDifferences = pairs.map(
    (pair) => pair.controlMinusChangedCacheReadTokens
  );
  const ratioDifferences = pairs.flatMap((pair) =>
    pair.controlCacheReadRatio === null || pair.changedCacheReadRatio === null
      ? []
      : [pair.controlMinusChangedCacheReadRatio]
  );
  const inputTokenDifferences = pairs.map(
    (pair) => pair.controlMinusChangedInputTokens
  );
  return {
    eligiblePairs: pairs.length,
    medianControlMinusChangedCacheReadTokens: median(tokenDifferences),
    p25ControlMinusChangedCacheReadTokens: quantile(tokenDifferences, 0.25),
    p75ControlMinusChangedCacheReadTokens: quantile(tokenDifferences, 0.75),
    cacheReadTokenDifferenceSigns: {
      controlHigher: tokenDifferences.filter((difference) => difference > 0)
        .length,
      equal: tokenDifferences.filter((difference) => difference === 0).length,
      changedHigher: tokenDifferences.filter((difference) => difference < 0)
        .length,
    },
    cacheReadRatioDifferenceSigns: ratioDifferenceSigns(pairs),
    responseIdIntegrityStatuses: {
      accepted: pairs.filter(
        (pair) => pair.responseIdIntegrityStatus === "accepted"
      ).length,
      crossBodyDuplicate: pairs.filter(
        (pair) => pair.responseIdIntegrityStatus === "cross-body-duplicate"
      ).length,
      duplicate: pairs.filter(
        (pair) => pair.responseIdIntegrityStatus === "duplicate"
      ).length,
    },
    serviceTierPairStatuses: metadataPairStatusCounts(
      pairs.map((pair) => pair.serviceTierPairStatus)
    ),
    systemFingerprintPairStatuses: metadataPairStatusCounts(
      pairs.map((pair) => pair.systemFingerprintPairStatus)
    ),
    inputTokenDifferenceSigns: {
      controlHigher: inputTokenDifferences.filter(
        (difference) => difference > 0
      ).length,
      equal: inputTokenDifferences.filter((difference) => difference === 0)
        .length,
      changedHigher: inputTokenDifferences.filter(
        (difference) => difference < 0
      ).length,
    },
    medianControlMinusChangedInputTokens: median(inputTokenDifferences),
    p25ControlMinusChangedInputTokens: quantile(inputTokenDifferences, 0.25),
    p75ControlMinusChangedInputTokens: quantile(inputTokenDifferences, 0.75),
    medianControlMinusChangedLatencyMs: median(
      pairs.map((pair) => pair.controlMinusChangedLatencyMs)
    ),
    medianControlMinusChangedCacheReadRatio: median(ratioDifferences),
    medianControlMinusChangedCacheReadRatioSign: exactRatioMedianSign(pairs),
    p25ControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.25),
    p75ControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.75),
  };
}

function metadataPairStatusCounts(statuses: readonly PairMetadataStatus[]) {
  return {
    matched: statuses.filter((status) => status === "matched").length,
    mismatched: statuses.filter((status) => status === "mismatched").length,
    unavailable: statuses.filter((status) => status === "unavailable").length,
  };
}

function ratioDifferenceSigns<
  Pair extends {
    readonly changedCacheReadTokens: number;
    readonly changedInputTokens: number;
    readonly controlCacheReadTokens: number;
    readonly controlInputTokens: number;
  },
>(pairs: readonly Pair[]) {
  const signs = pairs.map((pair) =>
    exactRatioDifferenceSign(
      pair.controlCacheReadTokens,
      pair.controlInputTokens,
      pair.changedCacheReadTokens,
      pair.changedInputTokens
    )
  );
  return {
    controlHigher: signs.filter((sign) => sign > 0).length,
    equal: signs.filter((sign) => sign === 0).length,
    changedHigher: signs.filter((sign) => sign < 0).length,
  };
}

function exactRatioMedianSign<
  Pair extends {
    readonly changedCacheReadTokens: number;
    readonly changedInputTokens: number;
    readonly controlCacheReadTokens: number;
    readonly controlInputTokens: number;
  },
>(pairs: readonly Pair[]): -1 | 0 | 1 | null {
  if (pairs.length === 0) {
    return null;
  }
  const fractions = pairs
    .map((pair) => ({
      denominator:
        BigInt(pair.controlInputTokens) * BigInt(pair.changedInputTokens),
      numerator:
        BigInt(pair.controlCacheReadTokens) * BigInt(pair.changedInputTokens) -
        BigInt(pair.changedCacheReadTokens) * BigInt(pair.controlInputTokens),
    }))
    .sort((left, right) => {
      const difference =
        left.numerator * right.denominator - right.numerator * left.denominator;
      return bigIntSign(difference);
    });
  const upperIndex = Math.floor(fractions.length / 2);
  const upper = fractions[upperIndex];
  if (!upper) {
    return null;
  }
  let medianNumerator = upper.numerator;
  if (fractions.length % 2 === 0) {
    const lower = fractions[upperIndex - 1];
    if (!lower) {
      return null;
    }
    medianNumerator =
      lower.numerator * upper.denominator + upper.numerator * lower.denominator;
  }
  return bigIntSign(medianNumerator);
}

function bigIntSign(value: bigint): -1 | 0 | 1 {
  if (value > 0n) {
    return 1;
  }
  if (value < 0n) {
    return -1;
  }
  return 0;
}

function exactRatioDifferenceSign(
  controlRead: number,
  controlInput: number,
  changedRead: number,
  changedInput: number
): -1 | 0 | 1 {
  const crossDifference =
    BigInt(controlRead) * BigInt(changedInput) -
    BigInt(changedRead) * BigInt(controlInput);
  return bigIntSign(crossDifference);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function settleForAtLeast(milliseconds: number): Promise<number> {
  const started = performance.now();
  while (true) {
    const elapsed = Math.floor(performance.now() - started);
    if (elapsed >= milliseconds) {
      return elapsed;
    }
    await sleep(milliseconds - elapsed);
  }
}

function serializeBenchmarkResult(result: unknown, apiKey: string): string {
  if (containsCredentialLikeString(result, apiKey)) {
    throw new Error(
      "Refusing to write benchmark output containing a credential."
    );
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (
    serialized.includes(apiKey) ||
    BEARER_PATTERN.test(serialized) ||
    KEY_LIKE_PATTERN.test(serialized)
  ) {
    throw new Error(
      "Refusing to write benchmark output containing a credential."
    );
  }
  return serialized;
}

function containsCredentialLikeString(value: unknown, apiKey: string): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (
        current.includes(apiKey) ||
        BEARER_PATTERN.test(current) ||
        KEY_LIKE_PATTERN.test(current)
      ) {
        return true;
      }
      continue;
    }
    if (current === null || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
    } else {
      stack.push(...Object.values(current));
    }
  }
  return false;
}

async function modelPreflight({
  apiKey,
  options,
}: {
  readonly apiKey: string;
  readonly options: CliOptions;
}): Promise<Record<string, unknown>> {
  if (!options.preflightModels) {
    return {
      checkedAt: null,
      presentModelIds: null,
      requestedModelIds: options.models,
      status: "skipped",
    };
  }
  const checkedAt = new Date().toISOString();
  const response = await fetch(`${options.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`Model preflight failed with HTTP ${response.status}.`);
  }
  const body = await readBoundedJsonResponse(response, MAX_MODEL_CATALOG_BYTES);
  const dataProperty = isPlainRecord(body)
    ? ownDataProperty(body, "data")
    : { present: false, valid: true, value: undefined };
  const data =
    dataProperty.valid && dataProperty.present
      ? denseOwnArrayValues(dataProperty.value)
      : null;
  if (data === null) {
    throw new Error("Model preflight returned an invalid catalog shape.");
  }
  const available = new Set<string>();
  for (const entry of data) {
    const id = isPlainRecord(entry) ? ownDataValue(entry, "id") : undefined;
    if (typeof id === "string" && SAFE_MODEL_ID_PATTERN.test(id)) {
      available.add(id);
    }
  }
  const presentModelIds = options.models.filter((model) =>
    available.has(model)
  );
  const missingModelIds = options.models.filter(
    (model) => !available.has(model)
  );
  if (missingModelIds.length > 0) {
    throw new Error(
      `Model preflight did not find requested model(s): ${missingModelIds.join(", ")}.`
    );
  }
  return {
    checkedAt,
    presentModelIds,
    requestedModelIds: options.models,
    status: "passed",
  };
}

async function benchmarkArm({
  apiKey,
  arm,
  armPosition,
  isolationToken,
  model,
  options,
  pairOrder,
  requestSequence,
  scenario,
  trial,
}: {
  readonly apiKey: string;
  readonly arm: ScenarioArm;
  readonly armPosition: ArmPosition;
  readonly isolationToken: string;
  readonly model: string;
  readonly options: CliOptions;
  readonly pairOrder: PairOrder;
  readonly requestSequence: { value: number };
  readonly scenario: ScenarioDefinition;
  readonly trial: number;
}): Promise<readonly [RequestResult, RequestResult]> {
  const namespace = `cache-arm-${isolationToken}`;
  requestSequence.value += 1;
  const warmup = await runRequest({
    armPosition,
    apiKey,
    isolationToken,
    model,
    namespace,
    options,
    pairOrder,
    phase: "warmup",
    requestSequence: requestSequence.value,
    scenario: scenario.name,
    toolNames: scenario.warmupTools,
    trial,
    variant: arm.variant,
  });
  const settleElapsedMs = await settleForAtLeast(options.settleMs);
  requestSequence.value += 1;
  const measuredResult = await runRequest({
    armPosition,
    apiKey,
    isolationToken,
    model,
    namespace,
    options,
    pairOrder,
    phase: "measure",
    requestSequence: requestSequence.value,
    scenario: scenario.name,
    toolNames: arm.measuredTools,
    trial,
    variant: arm.variant,
  });
  const warmupPrerequisitePassed =
    warmup.success && warmup.responseModelMatchesRequested === true;
  const measured: RequestResult = {
    ...measuredResult,
    cacheTelemetryEligible:
      measuredResult.cacheTelemetryEligible && warmupPrerequisitePassed,
    settleElapsedMs,
    warmupPrerequisitePassed,
  };
  const captureStatus = measured.success ? "capture-ok" : measured.errorCode;
  let eligibilityStatus = "warmup-prerequisite-failed";
  if (warmupPrerequisitePassed) {
    eligibilityStatus = "local-telemetry-ineligible";
  }
  if (measured.cacheTelemetryEligible) {
    eligibilityStatus = "eligible";
  }
  process.stderr.write(
    `  trial ${trial} ${scenario.name} ${pairOrder} ${arm.variant}: ${captureStatus}, ${eligibilityStatus}, cache-read=${measured.cacheReadTokens ?? "not-reported"}\n`
  );
  return [warmup, measured];
}

async function benchmarkModel({
  apiKey,
  model,
  options,
  orderAssignments,
  requestSequence,
  runId,
}: {
  readonly apiKey: string;
  readonly model: string;
  readonly options: CliOptions;
  readonly orderAssignments: Record<string, unknown>[];
  readonly requestSequence: { value: number };
  readonly runId: string;
}): Promise<Record<string, unknown>> {
  const requests: RequestResult[] = [];
  process.stderr.write(`Benchmarking ${model}\n`);
  for (let trial = 1; trial <= options.trials; trial += 1) {
    for (const scenario of options.scenarios) {
      const pairOrder = pairOrderFor({
        model,
        scenario: scenario.name,
        seed: options.seed,
        trial,
      });
      const arms = orderedArms(scenario, pairOrder);
      orderAssignments.push({
        model,
        pairOrder,
        scenario: scenario.name,
        trial,
        variants: arms.map((arm) => arm.variant),
      });
      for (const [armIndex, arm] of arms.entries()) {
        const armPosition = armIndex === 0 ? "first" : "second";
        const isolationToken = isolationTokenFor({
          armPosition,
          model,
          runId,
          scenario: scenario.name,
          trial,
        });
        requests.push(
          ...(await benchmarkArm({
            apiKey,
            arm,
            armPosition,
            isolationToken,
            model,
            options,
            pairOrder,
            requestSequence,
            scenario,
            trial,
          }))
        );
      }
    }
  }
  return {
    backendMetadataAudit: backendMetadataAudit(requests),
    cacheReporting: reportingStatus(requests),
    cacheWriteReporting: cacheWriteReportingStatus(requests),
    comparisons: comparisons(requests, options.scenarios),
    finishReasonAudit: finishReasonAudit(requests),
    isolationAudit: isolationAudit(requests),
    membershipInputTokenParityAudit: membershipInputTokenParityAudit(
      requests,
      MEMBERSHIP_SCENARIO
    ),
    model,
    outputComplianceAudit: outputComplianceAudit(requests),
    primaryComparisons: comparisons(requests, options.scenarios, "primary"),
    primaryMembershipInputTokenParityAudit: membershipInputTokenParityAudit(
      requests,
      MEMBERSHIP_SCENARIO,
      "primary"
    ),
    requests,
    requestOutcomeAudit: requestOutcomeAudit(requests),
    responseModelAudit: responseModelAudit(requests),
    responseIdAudit: responseIdAudit(requests),
    summaries: options.scenarios.flatMap(({ arms, name }) =>
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
    usageFieldStatusAudit: usageFieldStatusAudit(requests),
  };
}

async function runBenchmark(
  options: CliOptions,
  providedApiKey: string,
  dependencies: {
    readonly repositoryState?: () => Promise<RepositoryState>;
    readonly sourceSnapshot?: () => Promise<BenchmarkSourceSnapshot>;
    readonly sourceFreezeTreeVerifier?: (
      snapshot: BenchmarkSourceSnapshot,
      commitSha: string
    ) => Promise<void>;
  } = {}
): Promise<Record<string, unknown>> {
  const apiKey = providedApiKey.trim();
  if (!apiKey) {
    throw new TypeError("CACHE_BENCH_API_KEY is required.");
  }
  const readSourceSnapshot =
    dependencies.sourceSnapshot ?? benchmarkSourceSnapshot;
  const readRepositoryState = dependencies.repositoryState ?? repositoryState;
  const verifySourceFreezeTree =
    dependencies.sourceFreezeTreeVerifier ?? assertSourceSnapshotMatchesCommit;
  const initialRepositoryState = await readRepositoryState();
  if (options.campaignId !== null && !initialRepositoryState.worktreeClean) {
    throw new Error(
      "Evidence campaigns require a clean worktree at start; refusing to spend the live credential."
    );
  }
  const initialSourceSnapshot = await readSourceSnapshot();
  const postSnapshotRepositoryState = await readRepositoryState();
  assertRepositoryFreeze(
    initialRepositoryState,
    postSnapshotRepositoryState,
    "during the initial source snapshot",
    options.campaignId !== null
  );
  if (options.campaignId !== null) {
    await verifySourceFreezeTree(
      initialSourceSnapshot,
      initialRepositoryState.commitSha
    );
    const postTreeBindingRepositoryState = await readRepositoryState();
    assertRepositoryFreeze(
      initialRepositoryState,
      postTreeBindingRepositoryState,
      "during the source-freeze tree binding",
      true
    );
  }
  const preflight = await modelPreflight({ apiKey, options });
  const runId = randomUUID();
  const requestTopology = benchmarkRequestTopology(options);
  const models: Record<string, unknown>[] = [];
  const orderAssignments: Record<string, unknown>[] = [];
  const requestSequence = { value: 0 };

  for (const model of options.models) {
    models.push(
      await benchmarkModel({
        apiKey,
        model,
        options,
        orderAssignments,
        requestSequence,
        runId,
      })
    );
  }
  const allRequests = models.flatMap(
    (model) => model.requests as readonly RequestResult[]
  );
  const campaignResponseIdDuplicateSets = responseIdDuplicateSets(allRequests);
  for (const model of models) {
    const modelRequests = model.requests as readonly RequestResult[];
    model.comparisons = comparisons(
      modelRequests,
      options.scenarios,
      "all-sample",
      campaignResponseIdDuplicateSets
    );
    model.primaryComparisons = comparisons(
      modelRequests,
      options.scenarios,
      "primary",
      campaignResponseIdDuplicateSets
    );
    model.primaryMembershipInputTokenParityAudit =
      membershipInputTokenParityAudit(
        modelRequests,
        MEMBERSHIP_SCENARIO,
        "primary",
        campaignResponseIdDuplicateSets
      );
  }
  if (requestSequence.value !== requestTopology.totalRequests) {
    throw new Error(
      `Benchmark topology produced ${requestSequence.value} requests; expected ${requestTopology.totalRequests}.`
    );
  }
  const result = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    endpoint: options.baseUrl,
    protocol: "openai-chat-completions",
    credentialRecorded: false,
    configuration: {
      benchmarkSourceSha256: initialSourceSnapshot.benchmarkSourceSha256,
      campaignId: options.campaignId,
      implementationSourcesSha256:
        initialSourceSnapshot.implementationSourcesSha256,
      models: options.models,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      nodeVersion: process.version,
      runId,
      seed: options.seed,
      sourceFreezeCommitSha: initialRepositoryState.commitSha,
      sourceWorktreeCleanAtStart: initialRepositoryState.worktreeClean,
      trials: options.trials,
      prefixLines: options.prefixLines,
      settleMs: options.settleMs,
      timeoutMs: options.timeoutMs,
      modelPreflight: preflight,
      responseBodyLimits: {
        chatCompletionsBytes: MAX_CHAT_RESPONSE_BYTES,
        modelCatalogBytes: MAX_MODEL_CATALOG_BYTES,
      },
      requestTopology,
      fixedToolNames: FIXED_TOOL_NAMES,
      dynamicToolNames: DYNAMIC_TOOL_NAMES,
      membershipReplacementToolName: MEMBERSHIP_REPLACEMENT_TOOL_NAME,
      toolChoice: "omitted-auto",
      toolCallValidation:
        "Every HTTP-success response must contain a recognized choices array and zero tool calls; otherwise the request is marked unsuccessful.",
      finishReasonValidation: {
        acceptedZeroToolReasons: ACCEPTED_ZERO_TOOL_FINISH_REASONS,
        statuses: FINISH_REASON_STATUSES,
        policy:
          "The sole choice must report finish_reason=stop for capture success. Missing, accessor-backed, non-string, unknown, length, content_filter, function_call, and tool_calls values are stored only as sanitized status labels and fail closed; raw finish-reason values are never stored.",
      },
      eligibilitySemantics: {
        cacheTelemetryEligible:
          "A capture-success request is locally eligible for requested-model cache aggregation only when the sanitized response model exactly matches the requested model and input/cache-read/cache-write usage aliases form a valid envelope. A measured request additionally requires its own arm's warmup to be a capture success from that exact requested model.",
        captureSuccess:
          "HTTP success plus exactly one recognized choice/message, zero modern or legacy tool calls, finish_reason=stop, and exact trimmed text OK. Response-model attribution and usage validity are audited separately. HTTP failures retain only status-derived codes and local failures use a fixed allowlist; provider error strings are never retained or logged.",
      },
      outputValidation:
        "The result stores only whether the sole choice returned exact trimmed text OK; response text and tool arguments are never stored. Missing, malformed, multi-choice, and mismatched output fails capture and therefore cache-telemetry eligibility.",
      usageValidation:
        "Cache aggregates accept only nonnegative safe-integer input/read/write token observations. Read and write must each be no greater than input, their sum must be a safe integer no greater than input, and every cross-request sum must remain a safe integer or the campaign fails closed without evidence. Conflicting or malformed aliases retain only an audit status; their source and value are nulled instead of guessed or clamped. Output and total-token audit conflicts do not affect cache-read eligibility.",
      pairedUncertainty:
        "Paired summaries include descriptive p25/p75 intervals and exact raw-token, input-token, and cache-read/input-ratio signs overall and by AB/BA order. Ratio pair signs, ordering, and even-sample median signs use BigInt rational arithmetic rather than floating-point subtraction; float medians remain display-only. These are not confidence intervals.",
      sourceSnapshotSemantics:
        "Before an evidence campaign spends the credential, the runner records the current Git commit and requires a clean worktree, then compares every manifested current source byte and hash, including the benchmark runner, with its git show commit blob before provider preflight. It rechecks the same commit and cleanliness after that binding and before writing, then rechecks the commit again immediately before atomic rename after the temporary evidence file exists. Start/end source bytes must match. The freeze commit, clean-at-start result, and hashes are retained; transient edit-and-restore between checkpoints is not detected.",
      backendMetadataSemantics:
        "Nullable system_fingerprint and service_tier response fields are retained only as absent/null/invalid/hashed statuses plus SHA-256 digests. Multiple digests are reported as possible backend drift. These fields do not change per-request cache-telemetry eligibility, but matched non-null values gate primary paired sensitivity eligibility; raw values and raw provider payloads are never stored.",
      armIsolation: {
        canary:
          "Each model/scenario/trial execution slot (first or second) has a unique, fixed-length token in an equal-shape inert canary placed before every benchmark tool. Warmup and measure reuse the slot canary; alternating AB/BA order counterbalances each variant across slots.",
        promptNamespace:
          "Each model/scenario/trial execution slot has a unique, fixed-length system-message namespace shared only by its warmup and measurement; it is not derived from control/changed identity.",
      },
      armExecutionOrder: {
        mode: "seeded-alternating-ab-ba",
        algorithm:
          "A SHA-256 bit of seed, model, and scenario selects the first trial order; each later trial alternates it. Even trial counts are exactly balanced.",
        models: options.models,
        scenarios: options.scenarios.map((scenario) => scenario.name),
        variantsByScenario: Object.fromEntries(
          options.scenarios.map((scenario) => [
            scenario.name,
            scenario.arms.map((arm) => arm.variant),
          ])
        ),
        orderAssignments,
        phasesPerArm: ARM_EXECUTION_PHASES,
      },
      comparisonSemantics: {
        "same-set-order":
          "After an arm-specific canary, the warmup uses canonical order. The measured request either preserves it or reverses the same set.",
        "active-set-change":
          "After an arm-specific canary, the warmup uses the full canonical set. The measured request either preserves that set exactly or uses a smaller canonical subset with the fixed prefix intact.",
        "membership-only-change":
          "The measured request either preserves the warmup set or replaces one tool at the same position with an equal-byte definition, keeping tool count and serialized request length equal.",
      },
      effectConclusionPolicy:
        "Provider-reported raw cache-read-token differences and cache-read/input coverage-ratio differences are parallel descriptive endpoints. The all-sample view remains descriptive; the primary sensitivity view additionally requires one matched non-null system_fingerprint hash and one matched non-null service_tier hash across all four responses in a pair (each arm's warmup and measurement), and excludes any non-null response ID repeated anywhere in the campaign; reuse across distinct request-body hashes is separately audited. Missing backend metadata is unavailable for the primary view, not treated as a match. A model-level directional conclusion requires all four planned pairs in each AB/BA order stratum, matching nonzero median signs across endpoints, and no endpoint disagreement. Opposite raw-token and ratio directions are denominator-sensitive/indeterminate; every other endpoint disagreement is also indeterminate. Neither endpoint is a causal saving or cost estimate. Primary membership input parity uses the same four-response backend-metadata and response-ID pair universe; its all-sample view remains descriptive. Full input-token parity requires every planned primary pair to be observed and exactly equal. A pooled conclusion requires every planned primary pair in every model-by-order stratum and agreement with every model-level conclusion; model disagreement is indeterminate.",
      minimumOrderStratumCoverage: EVIDENCE_CAMPAIGN.minimumStratumCoverage,
    },
    interpretation: {
      "not-reported":
        "Successful responses did not expose a recognized cache-read usage field; this does not prove that no provider-side cache exists.",
      "reported-zero-only":
        "A recognized cache-read usage field was exposed, but every measured value was zero.",
      "reported-nonzero":
        "At least one measured response exposed a positive provider-reported cache-read token count.",
      unavailable:
        "No measured request passed response-model and usage-envelope eligibility.",
    },
    models,
    responseIdAudit: responseIdAudit(allRequests),
  };

  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  const serialized = serializeBenchmarkResult(result, apiKey);
  const preWriteRepositoryState = await readRepositoryState();
  assertRepositoryFreeze(
    initialRepositoryState,
    preWriteRepositoryState,
    "before the evidence write",
    options.campaignId !== null
  );
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
    const finalSourceSnapshot = await readSourceSnapshot();
    if (!sourceSnapshotsMatch(initialSourceSnapshot, finalSourceSnapshot)) {
      throw new Error(
        "Benchmark or implementation start/end source snapshots differ; refusing to write evidence."
      );
    }
    const preRenameRepositoryState = await readRepositoryState();
    assertRepositoryFreeze(
      initialRepositoryState,
      preRenameRepositoryState,
      "before atomic rename",
      false
    );
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  process.stderr.write(`Wrote ${outputPath}\n`);
  return result;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await runBenchmark(options, process.env.CACHE_BENCH_API_KEY ?? "");
}

export {
  ACCEPTED_ZERO_TOOL_FINISH_REASONS,
  ALL_TOOL_NAMES,
  ARM_EXECUTION_PHASES,
  assertSourceSnapshotMatchesCommit,
  BACKEND_METADATA_STATUSES,
  benchmarkRequestArtifacts,
  benchmarkRequestTopology,
  cacheMeasurementIsValid,
  DYNAMIC_TOOL_NAMES,
  EVIDENCE_CAMPAIGN,
  EVIDENCE_CAMPAIGN_TOPOLOGY,
  endpointCombinedConclusion,
  extractUsage,
  FINISH_REASON_STATUSES,
  FIXED_TOOL_NAMES,
  IMPLEMENTATION_SOURCE_PATHS,
  isolationTokenFor,
  localRequestErrorCode,
  MEMBERSHIP_REPLACEMENT_TOOL_NAME,
  MEMBERSHIP_SCENARIO,
  orderedTools,
  outputWasExactOk,
  pairOrderFor,
  parseOptions,
  readBoundedJsonResponse,
  responseFinishReasonStatuses,
  responseModel,
  responseToolCallCount,
  runBenchmark,
  safeTokenSum,
  sanitizedBackendMetadata,
  serializeBenchmarkResult,
  staticPrefix,
  variantSummary,
};

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  await main();
}
