#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const EXPECTED_ENDPOINT = "https://freerouter.minpeter.workers.dev/v1";
const MAX_EVIDENCE_BYTES = 10_000_000;
const MAX_README_BYTES = 1_000_000;
const EXPECTED_CAMPAIGN_ID = "pr208-cache-v3-20260717";
const EXPECTED_MODELS = Object.freeze([
  "minimaxai/minimax-m2.7",
  "minimaxai/minimax-m3",
  "mistralai/ministral-14b-latest",
  "qwen/qwen2.5-7b-instruct",
  "zai-org/glm-4.7",
]);
const FIXED_TOOL_NAMES = Object.freeze([
  "runtime_status",
  "read_project_file",
  "list_project_files",
  "search_project_text",
]);
const DYNAMIC_TOOL_NAMES = Object.freeze([
  "query_issue_tracker",
  "query_release_notes",
  "query_session_memory",
  "query_dependency_docs",
]);
const ALL_TOOL_NAMES = Object.freeze([
  ...FIXED_TOOL_NAMES,
  ...DYNAMIC_TOOL_NAMES,
]);
const MEMBERSHIP_REPLACEMENT_TOOL_NAME = "query_archive_notes";
const EXPECTED_TRIALS = 8;
const MAX_CHAT_RESPONSE_BYTES = 1_000_000;
const MAX_MODEL_CATALOG_BYTES = 5_000_000;
const MINIMUM_ORDER_STRATUM_PAIRS = 4;
const PHASES = Object.freeze(["warmup", "measure"]);
const PAIR_ORDERS = Object.freeze(["control-first", "changed-first"]);
const FINISH_REASON_STATUSES = Object.freeze([
  "accepted-stop",
  "invalid",
  "missing",
  "rejected-content-filter",
  "rejected-function-call",
  "rejected-length",
  "rejected-tool-calls",
]);
const USAGE_STATUSES = Object.freeze([
  "absent",
  "valid",
  "invalid",
  "conflict",
]);
const BACKEND_METADATA_STATUSES = Object.freeze([
  "absent",
  "hashed",
  "invalid",
  "null",
]);
const CACHE_REPORTING_STATUSES = Object.freeze([
  "not-reported",
  "reported-nonzero",
  "reported-zero-only",
  "unavailable",
]);
const EXPECTED_METHODOLOGY = Object.freeze({
  armExecutionAlgorithm:
    "A SHA-256 bit of seed, model, and scenario selects the first trial order; each later trial alternates it. Even trial counts are exactly balanced.",
  armIsolation: Object.freeze({
    canary:
      "Each model/scenario/trial execution slot (first or second) has a unique, fixed-length token in an equal-shape inert canary placed before every benchmark tool. Warmup and measure reuse the slot canary; alternating AB/BA order counterbalances each variant across slots.",
    promptNamespace:
      "Each model/scenario/trial execution slot has a unique, fixed-length system-message namespace shared only by its warmup and measurement; it is not derived from control/changed identity.",
  }),
  backendMetadataSemantics:
    "Nullable system_fingerprint and service_tier response fields are retained only as absent/null/invalid/hashed statuses plus SHA-256 digests. Multiple digests are reported as possible backend drift. These fields do not change per-request cache-telemetry eligibility, but matched non-null values gate primary paired sensitivity eligibility; raw values and raw provider payloads are never stored.",
  comparisonSemantics: Object.freeze({
    "same-set-order":
      "After an arm-specific canary, the warmup uses canonical order. The measured request either preserves it or reverses the same set.",
    "active-set-change":
      "After an arm-specific canary, the warmup uses the full canonical set. The measured request either preserves that set exactly or uses a smaller canonical subset with the fixed prefix intact.",
    "membership-only-change":
      "The measured request either preserves the warmup set or replaces one tool at the same position with an equal-byte definition, keeping tool count and serialized request length equal.",
  }),
  effectConclusionPolicy:
    "Provider-reported raw cache-read-token differences and cache-read/input coverage-ratio differences are parallel descriptive endpoints. The all-sample view remains descriptive; the primary sensitivity view additionally requires one matched non-null system_fingerprint hash and one matched non-null service_tier hash across all four responses in a pair (each arm's warmup and measurement), and excludes any non-null response ID repeated anywhere in the campaign; reuse across distinct request-body hashes is separately audited. Missing backend metadata is unavailable for the primary view, not treated as a match. A model-level directional conclusion requires all four planned pairs in each AB/BA order stratum, matching nonzero median signs across endpoints, and no endpoint disagreement. Opposite raw-token and ratio directions are denominator-sensitive/indeterminate; every other endpoint disagreement is also indeterminate. Neither endpoint is a causal saving or cost estimate. Primary membership input parity uses the same four-response backend-metadata and response-ID pair universe; its all-sample view remains descriptive. Full input-token parity requires every planned primary pair to be observed and exactly equal. A pooled conclusion requires every planned primary pair in every model-by-order stratum and agreement with every model-level conclusion; model disagreement is indeterminate.",
  eligibilitySemantics: Object.freeze({
    cacheTelemetryEligible:
      "A capture-success request is locally eligible for requested-model cache aggregation only when the sanitized response model exactly matches the requested model and input/cache-read/cache-write usage aliases form a valid envelope. A measured request additionally requires its own arm's warmup to be a capture success from that exact requested model.",
    captureSuccess:
      "HTTP success plus exactly one recognized choice/message, zero modern or legacy tool calls, finish_reason=stop, and exact trimmed text OK. Response-model attribution and usage validity are audited separately. HTTP failures retain only status-derived codes and local failures use a fixed allowlist; provider error strings are never retained or logged.",
  }),
  finishReasonPolicy:
    "The sole choice must report finish_reason=stop for capture success. Missing, accessor-backed, non-string, unknown, length, content_filter, function_call, and tool_calls values are stored only as sanitized status labels and fail closed; raw finish-reason values are never stored.",
  outputValidation:
    "The result stores only whether the sole choice returned exact trimmed text OK; response text and tool arguments are never stored. Missing, malformed, multi-choice, and mismatched output fails capture and therefore cache-telemetry eligibility.",
  pairedUncertainty:
    "Paired summaries include descriptive p25/p75 intervals and exact raw-token, input-token, and cache-read/input-ratio signs overall and by AB/BA order. Ratio pair signs, ordering, and even-sample median signs use BigInt rational arithmetic rather than floating-point subtraction; float medians remain display-only. These are not confidence intervals.",
  sourceSnapshotSemantics:
    "Before an evidence campaign spends the credential, the runner records the current Git commit and requires a clean worktree, then compares every manifested current source byte and hash, including the benchmark runner, with its git show commit blob before provider preflight. It rechecks the same commit and cleanliness after that binding and before writing, then rechecks the commit again immediately before atomic rename after the temporary evidence file exists. Start/end source bytes must match. The freeze commit, clean-at-start result, and hashes are retained; transient edit-and-restore between checkpoints is not detected.",
  toolCallValidation:
    "Every HTTP-success response must contain a recognized choices array and zero tool calls; otherwise the request is marked unsuccessful.",
  usageValidation:
    "Cache aggregates accept only nonnegative safe-integer input/read/write token observations. Read and write must each be no greater than input, their sum must be a safe integer no greater than input, and every cross-request sum must remain a safe integer or the campaign fails closed without evidence. Conflicting or malformed aliases retain only an audit status; their source and value are nulled instead of guessed or clamped. Output and total-token audit conflicts do not affect cache-read eligibility.",
});
const EXPECTED_INTERPRETATION = Object.freeze({
  "not-reported":
    "Successful responses did not expose a recognized cache-read usage field; this does not prove that no provider-side cache exists.",
  "reported-nonzero":
    "At least one measured response exposed a positive provider-reported cache-read token count.",
  "reported-zero-only":
    "A recognized cache-read usage field was exposed, but every measured value was zero.",
  unavailable:
    "No measured request passed response-model and usage-envelope eligibility.",
});
const SCENARIOS = Object.freeze([
  Object.freeze({
    name: "same-set-order",
    controlVariant: "stable-order",
    changedVariant: "reversed-order",
    warmupTools: ALL_TOOL_NAMES,
    measuredTools: Object.freeze({
      "stable-order": ALL_TOOL_NAMES,
      "reversed-order": Object.freeze([...ALL_TOOL_NAMES].reverse()),
    }),
  }),
  Object.freeze({
    name: "active-set-change",
    controlVariant: "unchanged-active-set",
    changedVariant: "changed-active-set",
    warmupTools: ALL_TOOL_NAMES,
    measuredTools: Object.freeze({
      "unchanged-active-set": ALL_TOOL_NAMES,
      "changed-active-set": Object.freeze([
        ...FIXED_TOOL_NAMES,
        DYNAMIC_TOOL_NAMES[0],
        DYNAMIC_TOOL_NAMES[1],
      ]),
    }),
  }),
  Object.freeze({
    name: "membership-only-change",
    controlVariant: "unchanged-membership",
    changedVariant: "changed-membership",
    warmupTools: ALL_TOOL_NAMES,
    measuredTools: Object.freeze({
      "unchanged-membership": ALL_TOOL_NAMES,
      "changed-membership": Object.freeze(
        ALL_TOOL_NAMES.map((name) =>
          name === DYNAMIC_TOOL_NAMES[1]
            ? MEMBERSHIP_REPLACEMENT_TOOL_NAME
            : name
        )
      ),
    }),
  }),
]);
const SCENARIO_BY_NAME = new Map(
  SCENARIOS.map((scenario) => [scenario.name, scenario])
);
const EXPECTED_TOPOLOGY = Object.freeze({
  armsPerModel: 48,
  modelCount: 5,
  orderAssignmentCount: 120,
  pairOrderCount: 2,
  phasesPerArm: 2,
  requestsPerModel: 96,
  requestsPerScenario: Object.freeze({
    "same-set-order": 32,
    "active-set-change": 32,
    "membership-only-change": 32,
  }),
  scenarioCount: 3,
  totalRequests: 480,
});
const IMPLEMENTATION_SUPPORT_PATHS = Object.freeze([
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
]);
const REQUIRED_IMPLEMENTATION_SOURCE_PATHS = Object.freeze(
  await completeImplementationSourcePaths()
);
const REQUEST_KEYS = Object.freeze([
  "armPosition",
  "cacheReadSource",
  "cacheReadTokens",
  "cacheTelemetryEligible",
  "cacheWriteSource",
  "cacheWriteTokens",
  "completedAt",
  "errorCode",
  "httpStatus",
  "httpSuccess",
  "inputSource",
  "inputTokens",
  "isolationCanarySha256",
  "latencyMs",
  "outputTokens",
  "outputWasExactOk",
  "pairOrder",
  "phase",
  "requestBodyBytes",
  "requestBodySha256",
  "requestSequence",
  "responseFinishReasonStatuses",
  "responseIdSha256",
  "responseModel",
  "responseModelMatchesRequested",
  "responseToolCallCount",
  "scenario",
  "serviceTierSha256",
  "serviceTierStatus",
  "settleElapsedMs",
  "startedAt",
  "success",
  "systemFingerprintSha256",
  "systemFingerprintStatus",
  "toolsArrayBytes",
  "toolsArraySha256",
  "totalTokens",
  "trial",
  "usageFieldAudit",
  "variant",
  "warmupPrerequisitePassed",
]);
const MODEL_KEYS = Object.freeze([
  "backendMetadataAudit",
  "cacheReporting",
  "cacheWriteReporting",
  "comparisons",
  "finishReasonAudit",
  "isolationAudit",
  "membershipInputTokenParityAudit",
  "model",
  "outputComplianceAudit",
  "primaryComparisons",
  "primaryMembershipInputTokenParityAudit",
  "requestOutcomeAudit",
  "requests",
  "responseModelAudit",
  "responseIdAudit",
  "summaries",
  "usageFieldStatusAudit",
]);
const PAIRED_SUMMARY_KEYS = Object.freeze([
  "cacheReadRatioDifferenceSigns",
  "cacheReadTokenDifferenceSigns",
  "eligiblePairs",
  "inputTokenDifferenceSigns",
  "medianControlMinusChangedCacheReadRatio",
  "medianControlMinusChangedCacheReadRatioSign",
  "medianControlMinusChangedCacheReadTokens",
  "medianControlMinusChangedInputTokens",
  "medianControlMinusChangedLatencyMs",
  "p25ControlMinusChangedCacheReadRatio",
  "p25ControlMinusChangedCacheReadTokens",
  "p25ControlMinusChangedInputTokens",
  "p75ControlMinusChangedCacheReadRatio",
  "p75ControlMinusChangedCacheReadTokens",
  "p75ControlMinusChangedInputTokens",
  "responseIdIntegrityStatuses",
  "serviceTierPairStatuses",
  "systemFingerprintPairStatuses",
]);
const PAIR_KEYS = Object.freeze([
  "changedCacheReadRatio",
  "changedCacheReadTokens",
  "changedInputTokens",
  "changedLatencyMs",
  "controlCacheReadRatio",
  "controlCacheReadTokens",
  "controlInputTokens",
  "controlLatencyMs",
  "controlMinusChangedCacheReadTokens",
  "controlMinusChangedCacheReadRatio",
  "controlMinusChangedInputTokens",
  "controlMinusChangedLatencyMs",
  "pairOrder",
  "responseIdIntegrityStatus",
  "serviceTierPairStatus",
  "systemFingerprintPairStatus",
  "trial",
]);
const VARIANT_SUMMARY_KEYS = Object.freeze([
  "attempts",
  "cacheReadNonzero",
  "cacheReadNonzeroCoverage",
  "cacheReadReported",
  "cacheReadRatioCoverage",
  "cacheReadRatioEligible",
  "cacheReportCoverage",
  "cacheTelemetryEligible",
  "cacheWriteNonzero",
  "cacheWriteNonzeroCoverage",
  "cacheWriteReported",
  "cacheWriteRatioCoverage",
  "cacheWriteRatioEligible",
  "cacheWriteReportCoverage",
  "captureSuccesses",
  "medianCacheReadRatio",
  "medianCacheReadTokens",
  "medianCacheWriteRatio",
  "medianCacheWriteTokens",
  "medianInputTokens",
  "medianLatencyMs",
  "weightedCacheReadRatio",
  "weightedCacheWriteRatio",
]);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/u;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const KEY_LIKE_PATTERN = /\b(?:fr|sk)-[\w-]{8,}\b/u;
const BEARER_PATTERN = /Bearer\s/iu;
const FORBIDDEN_KEYS = new Set([
  "apikey",
  "authorization",
  "content",
  "headers",
  "messages",
  "requestbody",
  "responsebody",
  "responsetext",
  "toolarguments",
  "toolinput",
  "usagenumericfields",
]);
const CACHE_READ_SOURCES = new Set([
  "prompt_tokens_details.cached_tokens",
  "input_tokens_details.cached_tokens",
  "prompt_tokens_details.cache_read_tokens",
  "input_tokens_details.cache_read_tokens",
  "cache_read_input_tokens",
  "cache_read_tokens",
  "cached_input_tokens",
]);
const CACHE_WRITE_SOURCES = new Set([
  "prompt_tokens_details.cache_write_tokens",
  "input_tokens_details.cache_write_tokens",
  "prompt_tokens_details.cache_creation_tokens",
  "input_tokens_details.cache_creation_tokens",
  "cache_creation_input_tokens",
  "cache_write_input_tokens",
  "cache_write_tokens",
]);
const INPUT_SOURCES = new Set(["prompt_tokens", "input_tokens"]);
const README_START = "<!-- cache-stable-tools-independent-verifier:start -->";
const README_END = "<!-- cache-stable-tools-independent-verifier:end -->";
const execFileAsync = promisify(execFile);
const sourceFreezeManifestCache = new Map();

class EvidenceVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceVerificationError";
  }
}

function fail(path, message) {
  throw new EvidenceVerificationError(`${path}: ${message}`);
}

function check(condition, path, message) {
  if (!condition) {
    fail(path, message);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function completeImplementationSourcePaths() {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const runtimeSources = await regularFilesUnder(
    resolve(repositoryRoot, "packages/runtime/src"),
    "packages/runtime/src"
  );
  return [...IMPLEMENTATION_SUPPORT_PATHS, ...runtimeSources].sort();
}

async function regularFilesUnder(directory, relativeDirectory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(
        ...(await regularFilesUnder(
          resolve(directory, entry.name),
          relativePath
        ))
      );
      continue;
    }
    check(entry.isFile(), relativePath, "implementation source is not a file");
    paths.push(relativePath);
  }
  return paths;
}

function ownDescriptor(value, key, path) {
  check(value !== null && typeof value === "object", path, "must be an object");
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(`${path}.${String(key)}`, "property descriptor inspection failed");
  }
  check(descriptor !== undefined, `${path}.${String(key)}`, "is required");
  check(
    "value" in descriptor,
    `${path}.${String(key)}`,
    "must be an own data property"
  );
  return descriptor.value;
}

function plainRecord(value, path) {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    path,
    "must be a record"
  );
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail(path, "prototype inspection failed");
  }
  check(
    prototype === Object.prototype || prototype === null,
    path,
    "must have a plain prototype"
  );
  for (const key of Reflect.ownKeys(value)) {
    check(typeof key === "string", path, "symbol keys are forbidden");
    ownDescriptor(value, key, path);
  }
  return value;
}

function denseArray(value, path, expectedLength = null) {
  check(Array.isArray(value), path, "must be an array");
  const length = ownDescriptor(value, "length", path);
  check(
    Number.isSafeInteger(length) && length >= 0,
    `${path}.length`,
    "must be a nonnegative safe integer"
  );
  if (expectedLength !== null) {
    check(
      length === expectedLength,
      `${path}.length`,
      `must equal ${expectedLength}`
    );
  }
  const allowed = new Set(["length"]);
  for (let index = 0; index < length; index += 1) {
    allowed.add(String(index));
    ownDescriptor(value, String(index), path);
  }
  for (const key of Reflect.ownKeys(value)) {
    check(
      typeof key === "string" && allowed.has(key),
      path,
      `unexpected array property ${String(key)}`
    );
  }
  return value;
}

function exactKeys(value, expected, path) {
  plainRecord(value, path);
  const actual = Reflect.ownKeys(value).map(String).sort();
  const wanted = [...expected].sort();
  check(
    isDeepStrictEqual(actual, wanted),
    path,
    `keys must be exactly ${wanted.join(", ")}`
  );
  return value;
}

function value(value, key, path) {
  return ownDescriptor(value, key, path);
}

function exact(valueObserved, expected, path) {
  check(
    isDeepStrictEqual(valueObserved, expected),
    path,
    `must equal ${JSON.stringify(expected)}`
  );
}

function nonnegativeSafeInteger(observed, path) {
  check(
    Number.isSafeInteger(observed) && observed >= 0,
    path,
    "must be a nonnegative safe integer"
  );
  return observed;
}

function positiveSafeInteger(observed, path) {
  check(
    Number.isSafeInteger(observed) && observed > 0,
    path,
    "must be a positive safe integer"
  );
  return observed;
}

function nullableNonnegativeSafeInteger(observed, path) {
  if (observed !== null) {
    nonnegativeSafeInteger(observed, path);
  }
}

function validTimestamp(observed, path) {
  check(typeof observed === "string", path, "must be an ISO timestamp string");
  const parsed = Date.parse(observed);
  check(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === observed,
    path,
    "must be a canonical ISO timestamp"
  );
  return parsed;
}

function safeSum(values, path) {
  let total = 0;
  for (const [index, observed] of values.entries()) {
    nonnegativeSafeInteger(observed, `${path}[${index}]`);
    const next = total + observed;
    check(Number.isSafeInteger(next), path, "safe-integer sum overflow");
    total = next;
  }
  return total;
}

function safeDifference(left, right, path) {
  check(
    Number.isSafeInteger(left) && Number.isSafeInteger(right),
    path,
    "operands must be safe integers"
  );
  const result = left - right;
  check(Number.isSafeInteger(result), path, "safe-integer difference overflow");
  return result;
}

function quantile(values, probability) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const upperWeight = position - lowerIndex;
  return (
    sorted[lowerIndex] * (1 - upperWeight) + sorted[upperIndex] * upperWeight
  );
}

function staticPrefix(namespace, lineCount) {
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

function toolDescription(name, index) {
  const clauses = [];
  for (let clause = 0; clause < 18; clause += 1) {
    clauses.push(
      `INERT benchmark schema ${name} ${index}-${clause}: never call this function; it exists only to measure deterministic request-prefix reuse`
    );
  }
  return clauses.join(". ");
}

function toolDefinition(name, index) {
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

const TOOL_DEFINITIONS = new Map([
  ...ALL_TOOL_NAMES.map((name, index) => [name, toolDefinition(name, index)]),
  [
    MEMBERSHIP_REPLACEMENT_TOOL_NAME,
    toolDefinition(
      MEMBERSHIP_REPLACEMENT_TOOL_NAME,
      ALL_TOOL_NAMES.indexOf(DYNAMIC_TOOL_NAMES[1])
    ),
  ],
]);

function requestArtifacts({ isolationToken, model, prefixLines, toolNames }) {
  const canary = {
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
  const tools = [
    canary,
    ...toolNames.map((name) => {
      const definition = TOOL_DEFINITIONS.get(name);
      check(
        definition !== undefined,
        "request.tools",
        `unknown benchmark tool ${name}`
      );
      return definition;
    }),
  ];
  const toolsJson = JSON.stringify(tools);
  const requestBody = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: staticPrefix(`cache-arm-${isolationToken}`, prefixLines),
      },
      {
        role: "user",
        content: "Reply with exactly OK and do not call a tool.",
      },
    ],
    tools,
    max_tokens: 256,
    stream: false,
  });
  return {
    isolationCanarySha256: sha256(JSON.stringify(canary)),
    requestBodyBytes: Buffer.byteLength(requestBody),
    requestBodySha256: sha256(requestBody),
    toolsArrayBytes: Buffer.byteLength(toolsJson),
    toolsArraySha256: sha256(toolsJson),
  };
}

function pairOrderFor(model, scenario, seed, trial) {
  const seedStartsControl =
    Number.parseInt(sha256(`${seed}\0${model}\0${scenario}`).slice(0, 8), 16) %
      2 ===
    0;
  const controlFirst = trial % 2 === 1 ? seedStartsControl : !seedStartsControl;
  return controlFirst ? "control-first" : "changed-first";
}

function isolationTokenFor(model, runId, scenario, trial, armPosition) {
  return sha256(
    `${runId}\0${model}\0${scenario}\0${trial}\0${armPosition}`
  ).slice(0, 24);
}

function scenarioVariants(scenario) {
  return [scenario.controlVariant, scenario.changedVariant];
}

function orderedVariants(scenario, pairOrder) {
  const variants = scenarioVariants(scenario);
  return pairOrder === "control-first" ? variants : [...variants].reverse();
}

function usageEnvelopeIsValid(request) {
  const audit = request.usageFieldAudit;
  if (
    audit.input !== "valid" ||
    !["absent", "valid"].includes(audit.cacheRead) ||
    !["absent", "valid"].includes(audit.cacheWrite) ||
    !(Number.isSafeInteger(request.inputTokens) && request.inputTokens >= 0)
  ) {
    return false;
  }
  for (const token of [request.cacheReadTokens, request.cacheWriteTokens]) {
    if (
      token !== null &&
      !(
        Number.isSafeInteger(token) &&
        token >= 0 &&
        token <= request.inputTokens
      )
    ) {
      return false;
    }
  }
  if (request.cacheReadTokens !== null && request.cacheWriteTokens !== null) {
    const sum = request.cacheReadTokens + request.cacheWriteTokens;
    if (!(Number.isSafeInteger(sum) && sum <= request.inputTokens)) {
      return false;
    }
  }
  return true;
}

function cacheMeasurementIsValid(request) {
  return (
    usageEnvelopeIsValid(request) &&
    request.usageFieldAudit.cacheRead === "valid" &&
    Number.isSafeInteger(request.cacheReadTokens) &&
    request.cacheReadTokens >= 0
  );
}

function cacheWriteMeasurementIsValid(request) {
  return (
    usageEnvelopeIsValid(request) &&
    request.usageFieldAudit.cacheWrite === "valid" &&
    Number.isSafeInteger(request.cacheWriteTokens) &&
    request.cacheWriteTokens >= 0
  );
}

function localCacheTelemetryEligible(request) {
  return (
    request.success &&
    request.responseModelMatchesRequested === true &&
    usageEnvelopeIsValid(request)
  );
}

function metadataPairStatus(requests, statusField, hashField) {
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

function crossBodyDuplicateResponseIds(requests) {
  const bodiesByResponseId = new Map();
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

function duplicateResponseIds(requests) {
  const counts = new Map();
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

function responseIdDuplicateSets(requests) {
  return {
    crossBody: crossBodyDuplicateResponseIds(requests),
    duplicate: duplicateResponseIds(requests),
  };
}

function responseIdIntegrityStatus(requests, duplicateSets) {
  const responseIds = requests.flatMap((request) =>
    request?.responseIdSha256 === null ||
    request?.responseIdSha256 === undefined
      ? []
      : [request.responseIdSha256]
  );
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

function deriveResponseIdAudit(requests) {
  const reported = requests.flatMap((request) =>
    request.responseIdSha256 === null ? [] : [request.responseIdSha256]
  );
  const counts = new Map();
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

function finishReasonsAccepted(statuses) {
  return (
    Array.isArray(statuses) &&
    statuses.length > 0 &&
    statuses.every((status) => status === "accepted-stop")
  );
}

function expectedCaptureOutcome(request) {
  if (!request.httpSuccess) {
    return {
      success: false,
      errorCode:
        request.httpStatus === null
          ? request.errorCode
          : `http-${request.httpStatus}`,
    };
  }
  if (
    request.responseToolCallCount === null ||
    request.responseFinishReasonStatuses === null
  ) {
    return { success: false, errorCode: "invalid-response-shape" };
  }
  if (request.responseToolCallCount > 0) {
    return { success: false, errorCode: "unexpected-tool-call" };
  }
  if (!finishReasonsAccepted(request.responseFinishReasonStatuses)) {
    return { success: false, errorCode: "invalid-finish-reason" };
  }
  if (request.outputWasExactOk === null) {
    return { success: false, errorCode: "invalid-response-shape" };
  }
  if (request.outputWasExactOk === false) {
    return { success: false, errorCode: "unexpected-output" };
  }
  return { success: true, errorCode: null };
}

function differenceSigns(values) {
  return {
    controlHigher: values.filter((item) => item > 0).length,
    equal: values.filter((item) => item === 0).length,
    changedHigher: values.filter((item) => item < 0).length,
  };
}

function metadataPairStatusCounts(statuses) {
  return {
    matched: statuses.filter((status) => status === "matched").length,
    mismatched: statuses.filter((status) => status === "mismatched").length,
    unavailable: statuses.filter((status) => status === "unavailable").length,
  };
}

function exactRatioDifferenceSign(pair) {
  const crossDifference =
    BigInt(pair.controlCacheReadTokens) * BigInt(pair.changedInputTokens) -
    BigInt(pair.changedCacheReadTokens) * BigInt(pair.controlInputTokens);
  return bigIntSign(crossDifference);
}

function bigIntSign(value) {
  if (value > 0n) {
    return 1;
  }
  if (value < 0n) {
    return -1;
  }
  return 0;
}

function exactRatioMedianSign(pairs) {
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
  let medianNumerator = upper.numerator;
  if (fractions.length % 2 === 0) {
    const lower = fractions[upperIndex - 1];
    medianNumerator =
      lower.numerator * upper.denominator + upper.numerator * lower.denominator;
  }
  return bigIntSign(medianNumerator);
}

function summarizePairs(pairs) {
  const cacheDifferences = pairs.map(
    (pair) => pair.controlMinusChangedCacheReadTokens
  );
  const inputDifferences = pairs.map(
    (pair) => pair.controlMinusChangedInputTokens
  );
  const latencyDifferences = pairs.map(
    (pair) => pair.controlMinusChangedLatencyMs
  );
  const ratioDifferences = pairs.flatMap((pair) =>
    pair.controlCacheReadRatio === null || pair.changedCacheReadRatio === null
      ? []
      : [pair.controlMinusChangedCacheReadRatio]
  );
  const ratioSigns = pairs.map(exactRatioDifferenceSign);
  return {
    eligiblePairs: pairs.length,
    medianControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.5),
    p25ControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.25),
    p75ControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.75),
    cacheReadTokenDifferenceSigns: differenceSigns(cacheDifferences),
    cacheReadRatioDifferenceSigns: differenceSigns(ratioSigns),
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
    inputTokenDifferenceSigns: differenceSigns(inputDifferences),
    medianControlMinusChangedInputTokens: quantile(inputDifferences, 0.5),
    p25ControlMinusChangedInputTokens: quantile(inputDifferences, 0.25),
    p75ControlMinusChangedInputTokens: quantile(inputDifferences, 0.75),
    medianControlMinusChangedLatencyMs: quantile(latencyDifferences, 0.5),
    medianControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.5),
    medianControlMinusChangedCacheReadRatioSign: exactRatioMedianSign(pairs),
    p25ControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.25),
    p75ControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.75),
  };
}

function pairedCoordinatesMatch(control, changed) {
  return (
    control.trial === changed.trial &&
    control.scenario === changed.scenario &&
    control.pairOrder === changed.pairOrder &&
    (control.pairOrder === "control-first"
      ? control.armPosition === "first" && changed.armPosition === "second"
      : control.armPosition === "second" && changed.armPosition === "first")
  );
}

function buildPairs(
  requests,
  scenario,
  view = "all-sample",
  providedDuplicateSets = null
) {
  const duplicateSets =
    providedDuplicateSets ?? responseIdDuplicateSets(requests);
  const measured = requests.filter(
    (request) =>
      request.phase === "measure" && request.scenario === scenario.name
  );
  const pairs = [];
  for (let trial = 1; trial <= EXPECTED_TRIALS; trial += 1) {
    const control = measured.find(
      (request) =>
        request.trial === trial && request.variant === scenario.controlVariant
    );
    const changed = measured.find(
      (request) =>
        request.trial === trial && request.variant === scenario.changedVariant
    );
    if (!(control && changed && pairedCoordinatesMatch(control, changed))) {
      continue;
    }
    if (
      !(
        control.cacheTelemetryEligible &&
        changed.cacheTelemetryEligible &&
        cacheMeasurementIsValid(control) &&
        cacheMeasurementIsValid(changed) &&
        control.inputTokens > 0 &&
        changed.inputTokens > 0
      )
    ) {
      continue;
    }
    const fourRequestPair = [
      requests.find(
        (request) =>
          request.phase === "warmup" &&
          request.scenario === control.scenario &&
          request.trial === control.trial &&
          request.variant === control.variant
      ),
      control,
      requests.find(
        (request) =>
          request.phase === "warmup" &&
          request.scenario === changed.scenario &&
          request.trial === changed.trial &&
          request.variant === changed.variant
      ),
      changed,
    ];
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
    if (
      view === "primary" &&
      (systemFingerprintPairStatus !== "matched" ||
        serviceTierPairStatus !== "matched" ||
        observedResponseIdIntegrityStatus !== "accepted")
    ) {
      continue;
    }
    pairs.push({
      pairOrder: control.pairOrder,
      trial,
      controlCacheReadTokens: control.cacheReadTokens,
      changedCacheReadTokens: changed.cacheReadTokens,
      controlInputTokens: control.inputTokens,
      changedInputTokens: changed.inputTokens,
      controlMinusChangedCacheReadTokens: safeDifference(
        control.cacheReadTokens,
        changed.cacheReadTokens,
        "pair.cacheDifference"
      ),
      controlMinusChangedInputTokens: safeDifference(
        control.inputTokens,
        changed.inputTokens,
        "pair.inputDifference"
      ),
      controlLatencyMs: control.latencyMs,
      changedLatencyMs: changed.latencyMs,
      controlMinusChangedLatencyMs: safeDifference(
        control.latencyMs,
        changed.latencyMs,
        "pair.latencyDifference"
      ),
      controlCacheReadRatio:
        control.inputTokens > 0
          ? control.cacheReadTokens / control.inputTokens
          : null,
      changedCacheReadRatio:
        changed.inputTokens > 0
          ? changed.cacheReadTokens / changed.inputTokens
          : null,
      controlMinusChangedCacheReadRatio:
        control.cacheReadTokens / control.inputTokens -
        changed.cacheReadTokens / changed.inputTokens,
      responseIdIntegrityStatus: observedResponseIdIntegrityStatus,
      serviceTierPairStatus,
      systemFingerprintPairStatus,
    });
  }
  return pairs;
}

function deriveComparisons(
  requests,
  view = "all-sample",
  providedDuplicateSets = null
) {
  return SCENARIOS.map((scenario) => {
    const pairs = buildPairs(requests, scenario, view, providedDuplicateSets);
    const orderStrata = PAIR_ORDERS.map((pairOrder) => ({
      pairOrder,
      ...summarizePairs(pairs.filter((pair) => pair.pairOrder === pairOrder)),
    }));
    const expectedPairsByOrder = Object.fromEntries(
      PAIR_ORDERS.map((pairOrder) => [
        pairOrder,
        requests.filter(
          (request) =>
            request.phase === "measure" &&
            request.scenario === scenario.name &&
            request.variant === scenario.controlVariant &&
            request.pairOrder === pairOrder
        ).length,
      ])
    );
    const cacheReadRatioConclusion = recordedDirectionalConclusion(
      expectedPairsByOrder,
      orderStrata,
      "medianControlMinusChangedCacheReadRatioSign"
    );
    const cacheReadTokenConclusion = recordedDirectionalConclusion(
      expectedPairsByOrder,
      orderStrata,
      "medianControlMinusChangedCacheReadTokens"
    );
    return {
      scenario: scenario.name,
      controlVariant: scenario.controlVariant,
      changedVariant: scenario.changedVariant,
      cacheReadRatioConclusion,
      cacheReadTokenConclusion,
      effectConclusion: endpointCombinedConclusion(
        cacheReadTokenConclusion,
        cacheReadRatioConclusion
      ),
      ...summarizePairs(pairs),
      orderStrata,
      pairs,
    };
  });
}

function endpointCombinedConclusion(tokenConclusion, ratioConclusion) {
  const directionFor = (conclusion) => {
    if (
      conclusion === "changed-higher" ||
      conclusion === "descriptive-changed-higher"
    ) {
      return "changed-higher";
    }
    if (
      conclusion === "control-higher" ||
      conclusion === "descriptive-control-higher"
    ) {
      return "control-higher";
    }
    return null;
  };
  const tokenDirection = directionFor(tokenConclusion);
  const ratioDirection = directionFor(ratioConclusion);
  if (tokenConclusion === ratioConclusion) {
    return ratioConclusion;
  }
  if (
    tokenConclusion.includes("insufficient") ||
    ratioConclusion.includes("insufficient")
  ) {
    return tokenConclusion.startsWith("indeterminate-")
      ? tokenConclusion
      : "insufficient-coverage";
  }
  if (
    tokenDirection !== null &&
    ratioDirection !== null &&
    tokenDirection !== ratioDirection
  ) {
    return "denominator-sensitive/indeterminate";
  }
  return "endpoint-disagreement/indeterminate";
}

function inputParityEligible(request) {
  return (
    request?.success &&
    request.responseModelMatchesRequested === true &&
    request.warmupPrerequisitePassed === true &&
    request.usageFieldAudit.input === "valid" &&
    Number.isSafeInteger(request.inputTokens) &&
    request.inputTokens >= 0
  );
}

function deriveMembershipParity(
  requests,
  view = "all-sample",
  providedDuplicateSets = null
) {
  const duplicateSets =
    providedDuplicateSets ?? responseIdDuplicateSets(requests);
  const scenario = SCENARIO_BY_NAME.get("membership-only-change");
  const measured = requests.filter(
    (request) =>
      request.phase === "measure" && request.scenario === scenario.name
  );
  const pairs = [];
  for (let trial = 1; trial <= EXPECTED_TRIALS; trial += 1) {
    const control = measured.find(
      (request) =>
        request.trial === trial && request.variant === scenario.controlVariant
    );
    const changed = measured.find(
      (request) =>
        request.trial === trial && request.variant === scenario.changedVariant
    );
    if (
      !(
        inputParityEligible(control) &&
        inputParityEligible(changed) &&
        pairedCoordinatesMatch(control, changed)
      )
    ) {
      continue;
    }
    const fourRequestPair = [
      requests.find(
        (request) =>
          request.phase === "warmup" &&
          request.scenario === control.scenario &&
          request.trial === control.trial &&
          request.variant === control.variant
      ),
      control,
      requests.find(
        (request) =>
          request.phase === "warmup" &&
          request.scenario === changed.scenario &&
          request.trial === changed.trial &&
          request.variant === changed.variant
      ),
      changed,
    ];
    if (
      view === "primary" &&
      (metadataPairStatus(
        fourRequestPair,
        "systemFingerprintStatus",
        "systemFingerprintSha256"
      ) !== "matched" ||
        metadataPairStatus(
          fourRequestPair,
          "serviceTierStatus",
          "serviceTierSha256"
        ) !== "matched" ||
        responseIdIntegrityStatus(fourRequestPair, duplicateSets) !==
          "accepted")
    ) {
      continue;
    }
    pairs.push({
      changedInputTokens: changed.inputTokens,
      controlInputTokens: control.inputTokens,
      controlMinusChangedInputTokens: safeDifference(
        control.inputTokens,
        changed.inputTokens,
        "membership.inputDifference"
      ),
      pairOrder: control.pairOrder,
      trial,
    });
  }
  const differences = pairs.map((pair) => pair.controlMinusChangedInputTokens);
  const orderStrata = PAIR_ORDERS.map((pairOrder) => {
    const stratumDifferences = pairs
      .filter((pair) => pair.pairOrder === pairOrder)
      .map((pair) => pair.controlMinusChangedInputTokens);
    return {
      pairOrder,
      changedHigher: stratumDifferences.filter((difference) => difference < 0)
        .length,
      controlHigher: stratumDifferences.filter((difference) => difference > 0)
        .length,
      eligiblePairs: stratumDifferences.length,
      equal: stratumDifferences.filter((difference) => difference === 0).length,
      medianDifference: quantile(stratumDifferences, 0.5),
    };
  });
  const expectedPairsByOrder = Object.fromEntries(
    PAIR_ORDERS.map((pairOrder) => [
      pairOrder,
      requests.filter(
        (request) =>
          request.phase === "measure" &&
          request.scenario === scenario.name &&
          request.variant === scenario.controlVariant &&
          request.pairOrder === pairOrder
      ).length,
    ])
  );
  return {
    changedHigher: differences.filter((difference) => difference < 0).length,
    controlHigher: differences.filter((difference) => difference > 0).length,
    effectConclusion: recordedDirectionalConclusion(
      expectedPairsByOrder,
      orderStrata,
      "medianDifference"
    ),
    eligiblePairs: pairs.length,
    equal: differences.filter((difference) => difference === 0).length,
    missingPairs: EXPECTED_TRIALS - pairs.length,
    orderStrata,
    pairs,
  };
}

function recordedDirectionalConclusion(
  expectedPairsByOrder,
  orderStrata,
  medianField
) {
  if (
    orderStrata.some((stratum) => {
      const expected = expectedPairsByOrder[stratum.pairOrder];
      return expected === 0 || stratum.eligiblePairs < expected;
    })
  ) {
    return "indeterminate-insufficient-order-stratum-coverage";
  }
  const medians = orderStrata.map((stratum) => stratum[medianField]);
  if (medians.some((median) => median === null)) {
    return "indeterminate-insufficient-order-stratum-coverage";
  }
  if (medians.every((median) => median === 0)) {
    return "no-observed-median-difference";
  }
  if (medians.every((median) => median > 0)) {
    return "control-higher";
  }
  if (medians.every((median) => median < 0)) {
    return "changed-higher";
  }
  return "order-sensitive";
}

function deriveVariantSummary(requests) {
  const eligible = requests.filter((request) => request.cacheTelemetryEligible);
  const cacheReported = eligible.filter(cacheMeasurementIsValid);
  const cacheWriteReported = eligible.filter(cacheWriteMeasurementIsValid);
  const readRatioEligible = cacheReported.filter(
    (request) => request.inputTokens > 0
  );
  const writeRatioEligible = cacheWriteReported.filter(
    (request) => request.inputTokens > 0
  );
  const cacheReadSum = safeSum(
    readRatioEligible.map((request) => request.cacheReadTokens),
    "summary.weightedCacheRead.tokens"
  );
  const cacheReadInputSum = safeSum(
    readRatioEligible.map((request) => request.inputTokens),
    "summary.weightedCacheRead.input"
  );
  const cacheWriteSum = safeSum(
    writeRatioEligible.map((request) => request.cacheWriteTokens),
    "summary.weightedCacheWrite.tokens"
  );
  const cacheWriteInputSum = safeSum(
    writeRatioEligible.map((request) => request.inputTokens),
    "summary.weightedCacheWrite.input"
  );
  const cacheReadNonzero = cacheReported.filter(
    (request) => request.cacheReadTokens > 0
  ).length;
  const cacheWriteNonzero = cacheWriteReported.filter(
    (request) => request.cacheWriteTokens > 0
  ).length;
  return {
    attempts: requests.length,
    cacheTelemetryEligible: eligible.length,
    cacheWriteNonzero,
    cacheWriteNonzeroCoverage:
      eligible.length === 0 ? null : cacheWriteNonzero / eligible.length,
    cacheWriteReported: cacheWriteReported.length,
    cacheWriteReportCoverage:
      eligible.length === 0
        ? null
        : cacheWriteReported.length / eligible.length,
    cacheWriteRatioEligible: writeRatioEligible.length,
    cacheWriteRatioCoverage:
      eligible.length === 0
        ? null
        : writeRatioEligible.length / eligible.length,
    captureSuccesses: requests.filter((request) => request.success).length,
    cacheReadReported: cacheReported.length,
    cacheReportCoverage:
      eligible.length === 0 ? null : cacheReported.length / eligible.length,
    cacheReadRatioEligible: readRatioEligible.length,
    cacheReadRatioCoverage:
      eligible.length === 0 ? null : readRatioEligible.length / eligible.length,
    cacheReadNonzero,
    cacheReadNonzeroCoverage:
      eligible.length === 0 ? null : cacheReadNonzero / eligible.length,
    medianCacheReadTokens: quantile(
      cacheReported.map((request) => request.cacheReadTokens),
      0.5
    ),
    medianCacheReadRatio: quantile(
      readRatioEligible.map(
        (request) => request.cacheReadTokens / request.inputTokens
      ),
      0.5
    ),
    medianInputTokens: quantile(
      eligible.flatMap((request) =>
        Number.isSafeInteger(request.inputTokens) && request.inputTokens >= 0
          ? [request.inputTokens]
          : []
      ),
      0.5
    ),
    medianCacheWriteRatio: quantile(
      writeRatioEligible.map(
        (request) => request.cacheWriteTokens / request.inputTokens
      ),
      0.5
    ),
    medianCacheWriteTokens: quantile(
      cacheWriteReported.map((request) => request.cacheWriteTokens),
      0.5
    ),
    medianLatencyMs: quantile(
      eligible.map((request) => request.latencyMs),
      0.5
    ),
    weightedCacheReadRatio:
      cacheReadInputSum === 0 ? null : cacheReadSum / cacheReadInputSum,
    weightedCacheWriteRatio:
      cacheWriteInputSum === 0 ? null : cacheWriteSum / cacheWriteInputSum,
  };
}

function responseModelSummary(requests) {
  const observed = {};
  for (const request of requests) {
    if (request.responseModel !== null) {
      observed[request.responseModel] =
        (observed[request.responseModel] ?? 0) + 1;
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
    observedResponseModels: observed,
  };
}

function backendMetadataFieldSummary(requests, hashField, statusField) {
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

function backendMetadataAudit(requests) {
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

function finishReasonSummary(requests) {
  const statuses = requests.flatMap(
    (request) => request.responseFinishReasonStatuses ?? []
  );
  return {
    acceptedResponses: requests.filter((request) =>
      finishReasonsAccepted(request.responseFinishReasonStatuses)
    ).length,
    choicesAudited: statuses.length,
    responseShapeUnavailable: requests.filter(
      (request) => request.responseFinishReasonStatuses === null
    ).length,
    responses: requests.length,
    statusCounts: Object.fromEntries(
      FINISH_REASON_STATUSES.map((status) => [
        status,
        statuses.filter((item) => item === status).length,
      ])
    ),
  };
}

function outputComplianceSummary(requests) {
  return {
    exact: requests.filter((request) => request.outputWasExactOk === true)
      .length,
    mismatch: requests.filter((request) => request.outputWasExactOk === false)
      .length,
    unavailable: requests.filter((request) => request.outputWasExactOk === null)
      .length,
  };
}

function reportingStatus(requests, kind) {
  const eligible = requests.filter(
    (request) => request.phase === "measure" && request.cacheTelemetryEligible
  );
  if (eligible.length === 0) {
    return "unavailable";
  }
  const reported = eligible.filter(
    kind === "read" ? cacheMeasurementIsValid : cacheWriteMeasurementIsValid
  );
  if (reported.length === 0) {
    return "not-reported";
  }
  const field = kind === "read" ? "cacheReadTokens" : "cacheWriteTokens";
  return reported.some((request) => request[field] > 0)
    ? "reported-nonzero"
    : "reported-zero-only";
}

function deriveIsolationAudit(requests) {
  const arms = new Map();
  for (const request of requests) {
    const key = `${request.scenario}\0${request.trial}\0${request.variant}`;
    arms.set(key, [...(arms.get(key) ?? []), request]);
  }
  const armValues = [...arms.values()];
  const canaries = armValues.map((arm) => arm[0]?.isolationCanarySha256);
  const warmups = requests.filter((request) => request.phase === "warmup");
  const equalByteSwap = (scenario) => {
    const measured = requests.filter(
      (request) => request.phase === "measure" && request.scenario === scenario
    );
    return Array.from(
      { length: EXPECTED_TRIALS },
      (_, index) => index + 1
    ).every((trial) => {
      const pair = measured.filter((request) => request.trial === trial);
      return (
        pair.length === 2 &&
        new Set(pair.map((request) => request.toolsArrayBytes)).size === 1 &&
        new Set(pair.map((request) => request.requestBodyBytes)).size === 1
      );
    });
  };
  return {
    armCount: arms.size,
    allArmsHaveOneWarmupAndOneMeasure: armValues.every(
      (arm) =>
        arm.length === 2 &&
        PHASES.every((phase) => arm.some((request) => request.phase === phase))
    ),
    allWarmupMeasurePairsShareCanary: armValues.every(
      (arm) =>
        new Set(arm.map((request) => request.isolationCanarySha256)).size === 1
    ),
    canariesUniqueAcrossArms:
      canaries.every(Boolean) && new Set(canaries).size === arms.size,
    uniqueCanaryHashCount: new Set(canaries).size,
    uniqueWarmupToolsArrayHashCount: new Set(
      warmups.map((request) => request.toolsArraySha256)
    ).size,
    uniqueWarmupToolsArrayByteCount: new Set(
      warmups.map((request) => request.toolsArrayBytes)
    ).size,
    membershipChangeIsEqualByteSwap: equalByteSwap("membership-only-change"),
    sameSetOrderIsEqualByteSwap: equalByteSwap("same-set-order"),
    slotsCounterbalancedAcrossVariants: SCENARIOS.every((scenario) =>
      scenarioVariants(scenario).every((variant) => {
        const positions = requests
          .filter(
            (request) =>
              request.phase === "measure" &&
              request.scenario === scenario.name &&
              request.variant === variant
          )
          .map((request) => request.armPosition);
        return (
          positions.filter((position) => position === "first").length ===
          positions.filter((position) => position === "second").length
        );
      })
    ),
    warmupCount: warmups.length,
    unexpectedToolCallResponseCount: requests.filter(
      (request) => (request.responseToolCallCount ?? 0) > 0
    ).length,
  };
}

function deriveModelViews(requests, providedDuplicateSets = null) {
  const measured = requests.filter((request) => request.phase === "measure");
  const captureSuccessful = requests.filter((request) => request.success);
  const statusAudit = {};
  for (const field of ["cacheRead", "cacheWrite", "input", "output", "total"]) {
    statusAudit[field] = Object.fromEntries(
      USAGE_STATUSES.map((status) => [
        status,
        requests.filter((request) => request.usageFieldAudit[field] === status)
          .length,
      ])
    );
  }
  return {
    backendMetadataAudit: backendMetadataAudit(requests),
    cacheReporting: reportingStatus(requests, "read"),
    cacheWriteReporting: reportingStatus(requests, "write"),
    comparisons: deriveComparisons(
      requests,
      "all-sample",
      providedDuplicateSets
    ),
    finishReasonAudit: {
      all: finishReasonSummary(requests),
      measure: finishReasonSummary(measured),
      warmup: finishReasonSummary(
        requests.filter((request) => request.phase === "warmup")
      ),
    },
    isolationAudit: deriveIsolationAudit(requests),
    membershipInputTokenParityAudit: deriveMembershipParity(requests),
    outputComplianceAudit: {
      all: outputComplianceSummary(requests),
      measure: outputComplianceSummary(measured),
      warmup: outputComplianceSummary(
        requests.filter((request) => request.phase === "warmup")
      ),
    },
    primaryComparisons: deriveComparisons(
      requests,
      "primary",
      providedDuplicateSets
    ),
    primaryMembershipInputTokenParityAudit: deriveMembershipParity(
      requests,
      "primary",
      providedDuplicateSets
    ),
    requestOutcomeAudit: {
      cacheUsageEnvelopeAudited: captureSuccessful.length,
      cacheUsageEnvelopeUnavailable: requests.length - captureSuccessful.length,
      cacheTelemetryEligible: requests.filter(
        (request) => request.cacheTelemetryEligible
      ).length,
      captureSuccess: captureSuccessful.length,
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
        localCacheTelemetryEligible
      ).length,
      measuredWarmupPrerequisiteFailures: measured.filter(
        (request) => request.warmupPrerequisitePassed === false
      ).length,
      invalidCacheUsageEnvelope: captureSuccessful.filter(
        (request) => !usageEnvelopeIsValid(request)
      ).length,
      positiveToolCallResponses: requests.filter(
        (request) => (request.responseToolCallCount ?? 0) > 0
      ).length,
      requests: requests.length,
    },
    responseModelAudit: {
      all: responseModelSummary(requests),
      measure: responseModelSummary(measured),
      warmup: responseModelSummary(
        requests.filter((request) => request.phase === "warmup")
      ),
    },
    responseIdAudit: deriveResponseIdAudit(requests),
    summaries: SCENARIOS.flatMap((scenario) =>
      scenarioVariants(scenario).map((variant) => ({
        scenario: scenario.name,
        variant,
        ...deriveVariantSummary(
          measured.filter(
            (request) =>
              request.scenario === scenario.name && request.variant === variant
          )
        ),
      }))
    ),
    usageFieldStatusAudit: statusAudit,
  };
}

function verifySourceBackedUsage(
  request,
  auditField,
  valueField,
  sourceField,
  allowedSources,
  path
) {
  const status = request.usageFieldAudit[auditField];
  check(
    USAGE_STATUSES.includes(status),
    `${path}.usageFieldAudit.${auditField}`,
    "has an unknown status"
  );
  if (status === "valid") {
    nonnegativeSafeInteger(request[valueField], `${path}.${valueField}`);
    check(
      allowedSources.has(request[sourceField]),
      `${path}.${sourceField}`,
      "is not a recognized source"
    );
  } else {
    exact(request[valueField], null, `${path}.${valueField}`);
    exact(request[sourceField], null, `${path}.${sourceField}`);
  }
}

function verifyUnbackedUsage(request, auditField, valueField, path) {
  const status = request.usageFieldAudit[auditField];
  check(
    USAGE_STATUSES.includes(status),
    `${path}.usageFieldAudit.${auditField}`,
    "has an unknown status"
  );
  if (status === "valid") {
    nonnegativeSafeInteger(request[valueField], `${path}.${valueField}`);
  } else {
    exact(request[valueField], null, `${path}.${valueField}`);
  }
}

function verifyHashedBackendMetadata(request, statusField, hashField, path) {
  const status = request[statusField];
  check(
    BACKEND_METADATA_STATUSES.includes(status),
    `${path}.${statusField}`,
    "has an unknown backend-metadata status"
  );
  if (status === "hashed") {
    check(
      typeof request[hashField] === "string" &&
        HASH_PATTERN.test(request[hashField]),
      `${path}.${hashField}`,
      "must be a lowercase SHA-256 when status is hashed"
    );
    return;
  }
  exact(request[hashField], null, `${path}.${hashField}`);
}

function verifyRequest(
  request,
  requestedModel,
  configuration,
  expectedCoordinate,
  previousCompletedAt,
  path
) {
  exactKeys(request, REQUEST_KEYS, path);
  exactKeys(
    request.usageFieldAudit,
    ["cacheRead", "cacheWrite", "input", "output", "total"],
    `${path}.usageFieldAudit`
  );
  for (const [key, expectedValue] of Object.entries(expectedCoordinate)) {
    exact(request[key], expectedValue, `${path}.${key}`);
  }
  for (const key of [
    "requestBodySha256",
    "toolsArraySha256",
    "isolationCanarySha256",
  ]) {
    check(
      typeof request[key] === "string" && HASH_PATTERN.test(request[key]),
      `${path}.${key}`,
      "must be a lowercase SHA-256"
    );
  }
  if (request.responseIdSha256 !== null) {
    check(
      typeof request.responseIdSha256 === "string" &&
        HASH_PATTERN.test(request.responseIdSha256),
      `${path}.responseIdSha256`,
      "must be null or a lowercase SHA-256"
    );
  }
  positiveSafeInteger(request.requestBodyBytes, `${path}.requestBodyBytes`);
  positiveSafeInteger(request.toolsArrayBytes, `${path}.toolsArrayBytes`);
  nonnegativeSafeInteger(request.latencyMs, `${path}.latencyMs`);
  const startedAt = validTimestamp(request.startedAt, `${path}.startedAt`);
  const completedAt = validTimestamp(
    request.completedAt,
    `${path}.completedAt`
  );
  check(
    completedAt >= startedAt,
    `${path}.completedAt`,
    "must not precede startedAt"
  );
  if (previousCompletedAt !== null) {
    check(
      startedAt >= previousCompletedAt,
      `${path}.startedAt`,
      "violates sequential request chronology"
    );
  }
  if (request.phase === "warmup") {
    exact(request.settleElapsedMs, null, `${path}.settleElapsedMs`);
  } else {
    nonnegativeSafeInteger(request.settleElapsedMs, `${path}.settleElapsedMs`);
    check(
      request.settleElapsedMs >= configuration.settleMs,
      `${path}.settleElapsedMs`,
      `must be at least the configured ${configuration.settleMs} ms`
    );
  }
  check(
    request.httpStatus === null ||
      (Number.isSafeInteger(request.httpStatus) &&
        request.httpStatus >= 100 &&
        request.httpStatus <= 599),
    `${path}.httpStatus`,
    "must be null or an HTTP status"
  );
  exact(
    request.httpSuccess,
    request.httpStatus !== null &&
      request.httpStatus >= 200 &&
      request.httpStatus < 300,
    `${path}.httpSuccess`
  );
  nullableNonnegativeSafeInteger(
    request.responseToolCallCount,
    `${path}.responseToolCallCount`
  );
  verifyResponseFields(request, requestedModel, path);
  verifyHashedBackendMetadata(
    request,
    "serviceTierStatus",
    "serviceTierSha256",
    path
  );
  verifyHashedBackendMetadata(
    request,
    "systemFingerprintStatus",
    "systemFingerprintSha256",
    path
  );
  verifySourceBackedUsage(
    request,
    "cacheRead",
    "cacheReadTokens",
    "cacheReadSource",
    CACHE_READ_SOURCES,
    path
  );
  verifySourceBackedUsage(
    request,
    "cacheWrite",
    "cacheWriteTokens",
    "cacheWriteSource",
    CACHE_WRITE_SOURCES,
    path
  );
  verifySourceBackedUsage(
    request,
    "input",
    "inputTokens",
    "inputSource",
    INPUT_SOURCES,
    path
  );
  verifyUnbackedUsage(request, "output", "outputTokens", path);
  verifyUnbackedUsage(request, "total", "totalTokens", path);
  const outcome = expectedCaptureOutcome(request);
  exact(request.success, outcome.success, `${path}.success`);
  if (request.httpStatus === null) {
    check(
      [
        "AbortError",
        "TimeoutError",
        "request-error",
        "response-too-large",
      ].includes(request.errorCode),
      `${path}.errorCode`,
      "must use a fixed local request-error code"
    );
  } else {
    exact(request.errorCode, outcome.errorCode, `${path}.errorCode`);
  }
  if (request.success) {
    exact(request.responseToolCallCount, 0, `${path}.responseToolCallCount`);
    exact(
      request.responseFinishReasonStatuses,
      ["accepted-stop"],
      `${path}.responseFinishReasonStatuses`
    );
    exact(request.outputWasExactOk, true, `${path}.outputWasExactOk`);
  }
  const scenario = SCENARIO_BY_NAME.get(request.scenario);
  const isolationToken = isolationTokenFor(
    requestedModel,
    configuration.runId,
    request.scenario,
    request.trial,
    request.armPosition
  );
  const toolNames =
    request.phase === "warmup"
      ? scenario.warmupTools
      : scenario.measuredTools[request.variant];
  const artifacts = requestArtifacts({
    isolationToken,
    model: requestedModel,
    prefixLines: configuration.prefixLines,
    toolNames,
  });
  for (const [key, expectedValue] of Object.entries(artifacts)) {
    exact(request[key], expectedValue, `${path}.${key}`);
  }
  return completedAt;
}

function verifyResponseFields(request, requestedModel, path) {
  if (request.responseFinishReasonStatuses !== null) {
    denseArray(
      request.responseFinishReasonStatuses,
      `${path}.responseFinishReasonStatuses`
    );
    check(
      request.responseFinishReasonStatuses.length > 0,
      `${path}.responseFinishReasonStatuses`,
      "must not be empty"
    );
    for (const [
      index,
      status,
    ] of request.responseFinishReasonStatuses.entries()) {
      check(
        FINISH_REASON_STATUSES.includes(status),
        `${path}.responseFinishReasonStatuses[${index}]`,
        "has an unknown status"
      );
    }
  }
  if (request.outputWasExactOk !== null) {
    check(
      request.responseToolCallCount !== null &&
        request.responseFinishReasonStatuses?.length === 1,
      `${path}.outputWasExactOk`,
      "a boolean output audit requires exactly one recognized choice/message"
    );
  }
  check(
    request.outputWasExactOk === null ||
      typeof request.outputWasExactOk === "boolean",
    `${path}.outputWasExactOk`,
    "must be null or boolean"
  );
  check(
    request.responseModel === null ||
      (typeof request.responseModel === "string" &&
        SAFE_MODEL_ID_PATTERN.test(request.responseModel)),
    `${path}.responseModel`,
    "must be null or a safe model id"
  );
  exact(
    request.responseModelMatchesRequested,
    request.responseModel === null
      ? null
      : request.responseModel === requestedModel,
    `${path}.responseModelMatchesRequested`
  );
}

function expectedCoordinatesForModel(model, seed, startSequence) {
  const coordinates = [];
  let sequence = startSequence;
  for (let trial = 1; trial <= EXPECTED_TRIALS; trial += 1) {
    for (const scenario of SCENARIOS) {
      const pairOrder = pairOrderFor(model, scenario.name, seed, trial);
      for (const [armIndex, variant] of orderedVariants(
        scenario,
        pairOrder
      ).entries()) {
        for (const phase of PHASES) {
          sequence += 1;
          coordinates.push({
            armPosition: armIndex === 0 ? "first" : "second",
            pairOrder,
            phase,
            requestSequence: sequence,
            scenario: scenario.name,
            trial,
            variant,
          });
        }
      }
    }
  }
  return coordinates;
}

function verifyWarmupLinkage(requests, settleMs, path) {
  for (const scenario of SCENARIOS) {
    for (let trial = 1; trial <= EXPECTED_TRIALS; trial += 1) {
      for (const variant of scenarioVariants(scenario)) {
        const armPath = `${path}.${scenario.name}.trial-${trial}.${variant}`;
        const arm = requests.filter(
          (request) =>
            request.scenario === scenario.name &&
            request.trial === trial &&
            request.variant === variant
        );
        check(
          arm.length === 2,
          armPath,
          "must contain exactly one warmup and one measurement"
        );
        const warmup = arm.find((request) => request.phase === "warmup");
        const measured = arm.find((request) => request.phase === "measure");
        check(warmup && measured, armPath, "must contain both phases");
        exact(
          measured.requestSequence,
          warmup.requestSequence + 1,
          `${armPath}.requestSequence`
        );
        check(
          Date.parse(measured.startedAt) - Date.parse(warmup.completedAt) >=
            settleMs,
          `${armPath}.measure.startedAt`,
          `must be at least ${settleMs} ms after warmup completion`
        );
        exact(
          warmup.warmupPrerequisitePassed,
          null,
          `${armPath}.warmup.warmupPrerequisitePassed`
        );
        exact(
          warmup.cacheTelemetryEligible,
          localCacheTelemetryEligible(warmup),
          `${armPath}.warmup.cacheTelemetryEligible`
        );
        const prerequisitePassed =
          warmup.success && warmup.responseModelMatchesRequested === true;
        exact(
          measured.warmupPrerequisitePassed,
          prerequisitePassed,
          `${armPath}.measure.warmupPrerequisitePassed`
        );
        exact(
          measured.cacheTelemetryEligible,
          prerequisitePassed && localCacheTelemetryEligible(measured),
          `${armPath}.measure.cacheTelemetryEligible`
        );
        exact(
          measured.isolationCanarySha256,
          warmup.isolationCanarySha256,
          `${armPath}.isolationCanarySha256`
        );
        const unchanged = [
          "stable-order",
          "unchanged-active-set",
          "unchanged-membership",
        ].includes(variant);
        exact(
          measured.toolsArraySha256 === warmup.toolsArraySha256,
          unchanged,
          `${armPath}.toolsArraySha256.reuse`
        );
        exact(
          measured.requestBodySha256 === warmup.requestBodySha256,
          unchanged,
          `${armPath}.requestBodySha256.reuse`
        );
      }
    }
  }
}

function compareRecorded(observed, expected, path) {
  check(
    isDeepStrictEqual(observed, expected),
    path,
    "does not match independent recomputation from sanitized requests"
  );
}

function validateRecordedViewSchemas(model, path) {
  validateComparisonView(model.comparisons, `${path}.comparisons`);
  validateComparisonView(
    model.primaryComparisons,
    `${path}.primaryComparisons`
  );
  denseArray(model.summaries, `${path}.summaries`, SCENARIOS.length * 2);
  for (const [index, summary] of model.summaries.entries()) {
    exactKeys(
      summary,
      ["scenario", "variant", ...VARIANT_SUMMARY_KEYS],
      `${path}.summaries[${index}]`
    );
  }
  validateResponseIdAuditSchema(
    model.responseIdAudit,
    `${path}.responseIdAudit`
  );
  validateMembershipParityAuditSchema(
    model.membershipInputTokenParityAudit,
    `${path}.membershipInputTokenParityAudit`
  );
  validateMembershipParityAuditSchema(
    model.primaryMembershipInputTokenParityAudit,
    `${path}.primaryMembershipInputTokenParityAudit`
  );
}

function validateMembershipParityAuditSchema(audit, path) {
  exactKeys(
    audit,
    [
      "changedHigher",
      "controlHigher",
      "effectConclusion",
      "eligiblePairs",
      "equal",
      "missingPairs",
      "orderStrata",
      "pairs",
    ],
    path
  );
  denseArray(audit.orderStrata, `${path}.orderStrata`, 2);
  for (const [index, stratum] of audit.orderStrata.entries()) {
    exactKeys(
      stratum,
      [
        "changedHigher",
        "controlHigher",
        "eligiblePairs",
        "equal",
        "medianDifference",
        "pairOrder",
      ],
      `${path}.orderStrata[${index}]`
    );
  }
  denseArray(audit.pairs, `${path}.pairs`);
  for (const [index, pair] of audit.pairs.entries()) {
    exactKeys(
      pair,
      [
        "changedInputTokens",
        "controlInputTokens",
        "controlMinusChangedInputTokens",
        "pairOrder",
        "trial",
      ],
      `${path}.pairs[${index}]`
    );
  }
}

function validateResponseIdAuditSchema(audit, path) {
  exactKeys(
    audit,
    [
      "crossRequestBodyDuplicateHashes",
      "crossRequestBodyDuplicateObservations",
      "distinct",
      "duplicateHashes",
      "duplicateObservations",
      "reported",
    ],
    path
  );
}

function validateComparisonView(comparisons, path) {
  denseArray(comparisons, path, SCENARIOS.length);
  for (const [index, comparison] of comparisons.entries()) {
    exactKeys(
      comparison,
      [
        "scenario",
        "controlVariant",
        "changedVariant",
        "cacheReadRatioConclusion",
        "cacheReadTokenConclusion",
        "effectConclusion",
        ...PAIRED_SUMMARY_KEYS,
        "orderStrata",
        "pairs",
      ],
      `${path}[${index}]`
    );
    denseArray(comparison.orderStrata, `${path}[${index}].orderStrata`, 2);
    for (const [stratumIndex, stratum] of comparison.orderStrata.entries()) {
      exactKeys(
        stratum,
        ["pairOrder", ...PAIRED_SUMMARY_KEYS],
        `${path}[${index}].orderStrata[${stratumIndex}]`
      );
    }
    denseArray(comparison.pairs, `${path}[${index}].pairs`);
    for (const [pairIndex, pair] of comparison.pairs.entries()) {
      exactKeys(pair, PAIR_KEYS, `${path}[${index}].pairs[${pairIndex}]`);
    }
  }
}

function direction(median) {
  if (median === null) {
    return "unavailable";
  }
  if (median > 0) {
    return "control-higher";
  }
  if (median < 0) {
    return "changed-higher";
  }
  return "equal";
}

function classifyOrderStrata(
  strata,
  medianField,
  directionalLabels,
  minimumPairs = MINIMUM_ORDER_STRATUM_PAIRS,
  directionField = medianField
) {
  const summarized = PAIR_ORDERS.map((pairOrder) => {
    const stratum = strata.find((item) => item.pairOrder === pairOrder);
    return {
      pairOrder,
      eligiblePairs: stratum?.eligiblePairs ?? 0,
      median: stratum?.[medianField] ?? null,
      direction: direction(stratum?.[directionField] ?? null),
    };
  });
  if (summarized.some((item) => item.eligiblePairs < minimumPairs)) {
    return { conclusion: "insufficient-coverage", orderStrata: summarized };
  }
  if (summarized[0].direction !== summarized[1].direction) {
    return {
      conclusion: "order-sensitive/indeterminate",
      orderStrata: summarized,
    };
  }
  return {
    conclusion: directionalLabels[summarized[0].direction],
    orderStrata: summarized,
  };
}

function descriptiveEndpoint(
  comparison,
  metric,
  medianField,
  minimumPairs = MINIMUM_ORDER_STRATUM_PAIRS,
  directionField = medianField
) {
  return {
    metric,
    ...classifyOrderStrata(
      comparison.orderStrata,
      medianField,
      {
        "control-higher": "descriptive-control-higher",
        "changed-higher": "descriptive-changed-higher",
        equal: "no-observed-median-difference",
        unavailable: "insufficient-coverage",
      },
      minimumPairs,
      directionField
    ),
  };
}

function effectForComparison(
  comparison,
  minimumPairs = MINIMUM_ORDER_STRATUM_PAIRS
) {
  const rawCacheReadTokens = descriptiveEndpoint(
    comparison,
    "provider-reported-raw-cache-read-tokens",
    "medianControlMinusChangedCacheReadTokens",
    minimumPairs
  );
  const cacheReadInputCoverageRatio = descriptiveEndpoint(
    comparison,
    "provider-reported-cache-read/input-coverage-ratio",
    "medianControlMinusChangedCacheReadRatio",
    minimumPairs,
    "medianControlMinusChangedCacheReadRatioSign"
  );
  return {
    conclusion: endpointCombinedConclusion(
      rawCacheReadTokens.conclusion,
      cacheReadInputCoverageRatio.conclusion
    ),
    endpoints: {
      rawCacheReadTokens,
      cacheReadInputCoverageRatio,
    },
  };
}

function membershipEffect(
  parity,
  minimumPairs = MINIMUM_ORDER_STRATUM_PAIRS,
  expectedPairsPerOrder = EXPECTED_TRIALS / PAIR_ORDERS.length
) {
  const strata = PAIR_ORDERS.map((pairOrder) => {
    const pairs = parity.pairs.filter((pair) => pair.pairOrder === pairOrder);
    return {
      pairOrder,
      eligiblePairs: pairs.length,
      medianControlMinusChangedInputTokens: quantile(
        pairs.map((pair) => pair.controlMinusChangedInputTokens),
        0.5
      ),
    };
  });
  const classified = classifyOrderStrata(
    strata,
    "medianControlMinusChangedInputTokens",
    {
      "control-higher": "descriptive-control-higher-input",
      "changed-higher": "descriptive-changed-higher-input",
      equal: "no-observed-median-input-token-difference",
      unavailable: "insufficient-coverage",
    },
    minimumPairs
  );
  const exactFullParity =
    classified.conclusion === "no-observed-median-input-token-difference" &&
    strata.every(
      (stratum) => stratum.eligiblePairs === expectedPairsPerOrder
    ) &&
    parity.pairs.every((pair) => pair.controlMinusChangedInputTokens === 0);
  return {
    metric: "input-token-difference",
    ...classified,
    conclusion: exactFullParity ? "input-token-parity" : classified.conclusion,
  };
}

function pooledComparison(
  models,
  scenario,
  view = "all-sample",
  providedDuplicateSets = null
) {
  const pairs = models.flatMap((model) => {
    const comparison = deriveComparisons(
      model.requests,
      view,
      providedDuplicateSets
    ).find((item) => item.scenario === scenario.name);
    return comparison.pairs.map((pair) => ({ ...pair, model: model.model }));
  });
  return {
    scenario: scenario.name,
    ...summarizePairs(pairs),
    orderStrata: PAIR_ORDERS.map((pairOrder) => ({
      pairOrder,
      ...summarizePairs(pairs.filter((pair) => pair.pairOrder === pairOrder)),
    })),
  };
}

function everyModelOrderStratumHasCoverage(models, pairsForModel) {
  return models.every((model) => {
    const pairs = pairsForModel(model);
    return PAIR_ORDERS.every(
      (pairOrder) =>
        pairs.filter((pair) => pair.pairOrder === pairOrder).length >=
        MINIMUM_ORDER_STRATUM_PAIRS
    );
  });
}

function reconcilePooledConclusion(
  pooledConclusion,
  modelConclusions,
  allModelOrderStrataCovered
) {
  if (!allModelOrderStrataCovered) {
    return "insufficient-coverage";
  }
  const distinct = new Set(modelConclusions);
  if (distinct.size !== 1 || !distinct.has(pooledConclusion)) {
    return "model-heterogeneous/indeterminate";
  }
  return pooledConclusion;
}

function buildReport(evidence, serialized) {
  const allRequests = evidence.models.flatMap((model) => model.requests);
  const campaignResponseIdDuplicateSets = responseIdDuplicateSets(allRequests);
  const modelRows = evidence.models.map((model) => ({
    model: model.model,
    requests: model.requests.length,
    captureSuccess: model.requests.filter((request) => request.success).length,
    cacheTelemetryEligible: model.requests.filter(
      (request) => request.cacheTelemetryEligible
    ).length,
    measuredCacheTelemetryEligible: model.requests.filter(
      (request) => request.phase === "measure" && request.cacheTelemetryEligible
    ).length,
    cacheReporting: reportingStatus(model.requests, "read"),
    cacheWriteReporting: reportingStatus(model.requests, "write"),
    backendMetadataAudit: backendMetadataAudit(model.requests),
    responseIdAudit: deriveResponseIdAudit(model.requests),
  }));
  const effects = evidence.models.flatMap((model) => {
    const allSample = deriveComparisons(
      model.requests,
      "all-sample",
      campaignResponseIdDuplicateSets
    );
    const primary = deriveComparisons(
      model.requests,
      "primary",
      campaignResponseIdDuplicateSets
    );
    return primary.map((comparison, index) => {
      const primaryEffect = effectForComparison(comparison);
      return {
        scope: model.model,
        scenario: comparison.scenario,
        conclusion: primaryEffect.conclusion,
        primary: primaryEffect,
        allSampleDescriptive: effectForComparison(allSample[index]),
      };
    });
  });
  for (const scenario of SCENARIOS) {
    const comparison = pooledComparison(
      evidence.models,
      scenario,
      "primary",
      campaignResponseIdDuplicateSets
    );
    const allSampleComparison = pooledComparison(
      evidence.models,
      scenario,
      "all-sample",
      campaignResponseIdDuplicateSets
    );
    const pooledEffect = effectForComparison(
      comparison,
      EXPECTED_MODELS.length * MINIMUM_ORDER_STRATUM_PAIRS
    );
    const allModelOrderStrataCovered = everyModelOrderStratumHasCoverage(
      evidence.models,
      (model) =>
        deriveComparisons(
          model.requests,
          "primary",
          campaignResponseIdDuplicateSets
        ).find((item) => item.scenario === scenario.name).pairs
    );
    const modelConclusions = effects
      .filter(
        (effect) =>
          effect.scope !== "pooled" && effect.scenario === scenario.name
      )
      .map((effect) => effect.conclusion);
    effects.push({
      scope: "pooled",
      scenario: scenario.name,
      conclusion: reconcilePooledConclusion(
        pooledEffect.conclusion,
        modelConclusions,
        allModelOrderStrataCovered
      ),
      primary: pooledEffect,
      allSampleDescriptive: effectForComparison(
        allSampleComparison,
        EXPECTED_MODELS.length * MINIMUM_ORDER_STRATUM_PAIRS
      ),
    });
  }
  const membershipInputParity = evidence.models.map((model) => {
    const primary = membershipEffect(
      deriveMembershipParity(
        model.requests,
        "primary",
        campaignResponseIdDuplicateSets
      )
    );
    return {
      scope: model.model,
      conclusion: primary.conclusion,
      primary,
      allSampleDescriptive: membershipEffect(
        deriveMembershipParity(model.requests)
      ),
    };
  });
  const pooledParityPairs = evidence.models.flatMap((model) =>
    deriveMembershipParity(
      model.requests,
      "primary",
      campaignResponseIdDuplicateSets
    ).pairs.map((pair) => ({
      ...pair,
      model: model.model,
    }))
  );
  const pooledMembershipEffect = membershipEffect(
    { pairs: pooledParityPairs },
    EXPECTED_MODELS.length * MINIMUM_ORDER_STRATUM_PAIRS,
    (EXPECTED_MODELS.length * EXPECTED_TRIALS) / PAIR_ORDERS.length
  );
  const allMembershipModelOrderStrataCovered =
    everyModelOrderStratumHasCoverage(
      evidence.models,
      (model) =>
        deriveMembershipParity(
          model.requests,
          "primary",
          campaignResponseIdDuplicateSets
        ).pairs
    );
  const pooledMembershipConclusion = reconcilePooledConclusion(
    pooledMembershipEffect.conclusion,
    membershipInputParity.map((effect) => effect.conclusion),
    allMembershipModelOrderStrataCovered
  );
  const pooledAllSampleParityPairs = evidence.models.flatMap((model) =>
    deriveMembershipParity(model.requests).pairs.map((pair) => ({
      ...pair,
      model: model.model,
    }))
  );
  membershipInputParity.push({
    scope: "pooled",
    conclusion: pooledMembershipConclusion,
    primary: {
      ...pooledMembershipEffect,
      conclusion: pooledMembershipConclusion,
    },
    allSampleDescriptive: membershipEffect(
      { pairs: pooledAllSampleParityPairs },
      EXPECTED_MODELS.length * MINIMUM_ORDER_STRATUM_PAIRS,
      (EXPECTED_MODELS.length * EXPECTED_TRIALS) / PAIR_ORDERS.length
    ),
  });
  return {
    evidenceSha256: sha256(serialized),
    generatedAt: evidence.generatedAt,
    campaignId: evidence.configuration.campaignId,
    aggregate: {
      expectedRequests: EXPECTED_TOPOLOGY.totalRequests,
      observedRequests: allRequests.length,
      captureSuccess: allRequests.filter((request) => request.success).length,
      cacheTelemetryEligible: allRequests.filter(
        (request) => request.cacheTelemetryEligible
      ).length,
      measuredCacheTelemetryEligible: allRequests.filter(
        (request) =>
          request.phase === "measure" && request.cacheTelemetryEligible
      ).length,
    },
    models: modelRows,
    effects,
    membershipInputParity,
    responseIdAudit: deriveResponseIdAudit(allRequests),
  };
}

function renderReadmeBlock(report) {
  return `${README_START}\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n${README_END}`;
}

function verifyReadme(readmeText, expectedBlock) {
  check(typeof readmeText === "string", "README", "text is required");
  const start = readmeText.indexOf(README_START);
  const end = readmeText.indexOf(README_END);
  check(
    start >= 0 && end > start,
    "README.snapshot",
    "canonical verifier marker block is missing"
  );
  check(
    readmeText.indexOf(README_START, start + README_START.length) === -1,
    "README.snapshot",
    "duplicate start marker"
  );
  check(
    readmeText.indexOf(README_END, end + README_END.length) === -1,
    "README.snapshot",
    "duplicate end marker"
  );
  const observed = readmeText.slice(start, end + README_END.length);
  exact(observed, expectedBlock, "README.snapshot");
}

function findForbiddenKeys(value, path = "evidence", found = []) {
  if (value === null || typeof value !== "object") {
    return found;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      findForbiddenKeys(
        ownDescriptor(value, String(index), path),
        `${path}[${index}]`,
        found
      );
    }
    return found;
  }
  plainRecord(value, path);
  for (const key of Reflect.ownKeys(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      found.push(`${path}.${key}`);
    }
    findForbiddenKeys(ownDescriptor(value, key, path), `${path}.${key}`, found);
  }
  return found;
}

function containsCredentialLikeString(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (BEARER_PATTERN.test(current) || KEY_LIKE_PATTERN.test(current)) {
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

async function verifySourceFreezeCommit(commitSha, repoRoot) {
  const cacheKey = `${repoRoot}\0${commitSha}`;
  let frozenManifest = sourceFreezeManifestCache.get(cacheKey);
  if (!frozenManifest) {
    frozenManifest = readFrozenSourceManifest(commitSha, repoRoot);
    sourceFreezeManifestCache.set(cacheKey, frozenManifest);
  }
  try {
    return await frozenManifest;
  } catch {
    sourceFreezeManifestCache.delete(cacheKey);
    fail(
      "configuration.sourceFreezeCommitSha",
      "must identify a commit containing every manifested source path"
    );
  }
}

async function readFrozenSourceManifest(commitSha, repoRoot) {
  await execFileAsync("git", ["cat-file", "-e", `${commitSha}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const sourcePaths = [
    "scripts/benchmark-cache-stable-tools.mts",
    ...REQUIRED_IMPLEMENTATION_SOURCE_PATHS,
  ];
  return new Map(
    await Promise.all(
      sourcePaths.map(async (sourcePath) => {
        const { stdout } = await execFileAsync(
          "git",
          ["show", `${commitSha}:${sourcePath}`],
          { cwd: repoRoot, encoding: null, maxBuffer: 20_000_000 }
        );
        return [sourcePath, sha256(stdout)];
      })
    )
  );
}

async function verifyConfiguration(configuration, repoRoot) {
  exactKeys(
    configuration,
    [
      "armExecutionOrder",
      "armIsolation",
      "backendMetadataSemantics",
      "benchmarkSourceSha256",
      "campaignId",
      "comparisonSemantics",
      "dynamicToolNames",
      "effectConclusionPolicy",
      "eligibilitySemantics",
      "finishReasonValidation",
      "fixedToolNames",
      "implementationSourcesSha256",
      "membershipReplacementToolName",
      "maxOutputTokens",
      "minimumOrderStratumCoverage",
      "modelPreflight",
      "models",
      "nodeVersion",
      "outputValidation",
      "pairedUncertainty",
      "prefixLines",
      "requestTopology",
      "responseBodyLimits",
      "runId",
      "seed",
      "settleMs",
      "sourceFreezeCommitSha",
      "sourceSnapshotSemantics",
      "sourceWorktreeCleanAtStart",
      "timeoutMs",
      "toolCallValidation",
      "toolChoice",
      "trials",
      "usageValidation",
    ],
    "configuration"
  );
  exact(
    configuration.campaignId,
    EXPECTED_CAMPAIGN_ID,
    "configuration.campaignId"
  );
  exact(configuration.models, EXPECTED_MODELS, "configuration.models");
  exact(configuration.trials, EXPECTED_TRIALS, "configuration.trials");
  exact(configuration.prefixLines, 700, "configuration.prefixLines");
  exact(configuration.maxOutputTokens, 256, "configuration.maxOutputTokens");
  exact(configuration.seed, EXPECTED_CAMPAIGN_ID, "configuration.seed");
  exact(configuration.settleMs, 1500, "configuration.settleMs");
  exact(configuration.timeoutMs, 120_000, "configuration.timeoutMs");
  exact(
    configuration.minimumOrderStratumCoverage,
    1,
    "configuration.minimumOrderStratumCoverage"
  );
  exact(
    configuration.fixedToolNames,
    FIXED_TOOL_NAMES,
    "configuration.fixedToolNames"
  );
  exact(
    configuration.dynamicToolNames,
    DYNAMIC_TOOL_NAMES,
    "configuration.dynamicToolNames"
  );
  exact(
    configuration.membershipReplacementToolName,
    MEMBERSHIP_REPLACEMENT_TOOL_NAME,
    "configuration.membershipReplacementToolName"
  );
  exact(
    configuration.requestTopology,
    EXPECTED_TOPOLOGY,
    "configuration.requestTopology"
  );
  exactKeys(
    configuration.responseBodyLimits,
    ["chatCompletionsBytes", "modelCatalogBytes"],
    "configuration.responseBodyLimits"
  );
  exact(
    configuration.responseBodyLimits,
    {
      chatCompletionsBytes: MAX_CHAT_RESPONSE_BYTES,
      modelCatalogBytes: MAX_MODEL_CATALOG_BYTES,
    },
    "configuration.responseBodyLimits"
  );
  check(
    typeof configuration.runId === "string" &&
      UUID_PATTERN.test(configuration.runId),
    "configuration.runId",
    "must be a UUIDv4"
  );
  check(
    typeof configuration.nodeVersion === "string" &&
      NODE_VERSION_PATTERN.test(configuration.nodeVersion),
    "configuration.nodeVersion",
    "must be a Node version"
  );
  exact(configuration.toolChoice, "omitted-auto", "configuration.toolChoice");
  exact(
    configuration.effectConclusionPolicy,
    EXPECTED_METHODOLOGY.effectConclusionPolicy,
    "configuration.effectConclusionPolicy"
  );
  exact(
    configuration.toolCallValidation,
    EXPECTED_METHODOLOGY.toolCallValidation,
    "configuration.toolCallValidation"
  );
  exact(
    configuration.outputValidation,
    EXPECTED_METHODOLOGY.outputValidation,
    "configuration.outputValidation"
  );
  exact(
    configuration.pairedUncertainty,
    EXPECTED_METHODOLOGY.pairedUncertainty,
    "configuration.pairedUncertainty"
  );
  exact(
    configuration.backendMetadataSemantics,
    EXPECTED_METHODOLOGY.backendMetadataSemantics,
    "configuration.backendMetadataSemantics"
  );
  exact(
    configuration.sourceSnapshotSemantics,
    EXPECTED_METHODOLOGY.sourceSnapshotSemantics,
    "configuration.sourceSnapshotSemantics"
  );
  check(
    typeof configuration.sourceFreezeCommitSha === "string" &&
      GIT_COMMIT_PATTERN.test(configuration.sourceFreezeCommitSha),
    "configuration.sourceFreezeCommitSha",
    "must be a lowercase Git SHA-1"
  );
  exact(
    configuration.sourceWorktreeCleanAtStart,
    true,
    "configuration.sourceWorktreeCleanAtStart"
  );
  const frozenSourceManifest = await verifySourceFreezeCommit(
    configuration.sourceFreezeCommitSha,
    repoRoot
  );
  exact(
    configuration.usageValidation,
    EXPECTED_METHODOLOGY.usageValidation,
    "configuration.usageValidation"
  );
  exactKeys(
    configuration.armIsolation,
    ["canary", "promptNamespace"],
    "configuration.armIsolation"
  );
  exact(
    configuration.armIsolation,
    EXPECTED_METHODOLOGY.armIsolation,
    "configuration.armIsolation"
  );
  exactKeys(
    configuration.eligibilitySemantics,
    ["cacheTelemetryEligible", "captureSuccess"],
    "configuration.eligibilitySemantics"
  );
  exact(
    configuration.eligibilitySemantics,
    EXPECTED_METHODOLOGY.eligibilitySemantics,
    "configuration.eligibilitySemantics"
  );
  exactKeys(
    configuration.finishReasonValidation,
    ["acceptedZeroToolReasons", "policy", "statuses"],
    "configuration.finishReasonValidation"
  );
  exact(
    configuration.finishReasonValidation.acceptedZeroToolReasons,
    ["stop"],
    "configuration.finishReasonValidation.acceptedZeroToolReasons"
  );
  exact(
    configuration.finishReasonValidation.statuses,
    FINISH_REASON_STATUSES,
    "configuration.finishReasonValidation.statuses"
  );
  exact(
    configuration.finishReasonValidation.policy,
    EXPECTED_METHODOLOGY.finishReasonPolicy,
    "configuration.finishReasonValidation.policy"
  );
  exactKeys(
    configuration.comparisonSemantics,
    SCENARIOS.map((scenario) => scenario.name),
    "configuration.comparisonSemantics"
  );
  exact(
    configuration.comparisonSemantics,
    EXPECTED_METHODOLOGY.comparisonSemantics,
    "configuration.comparisonSemantics"
  );
  exactKeys(
    configuration.modelPreflight,
    ["checkedAt", "presentModelIds", "requestedModelIds", "status"],
    "configuration.modelPreflight"
  );
  exact(
    configuration.modelPreflight.status,
    "passed",
    "configuration.modelPreflight.status"
  );
  exact(
    configuration.modelPreflight.presentModelIds,
    EXPECTED_MODELS,
    "configuration.modelPreflight.presentModelIds"
  );
  exact(
    configuration.modelPreflight.requestedModelIds,
    EXPECTED_MODELS,
    "configuration.modelPreflight.requestedModelIds"
  );
  validTimestamp(
    configuration.modelPreflight.checkedAt,
    "configuration.modelPreflight.checkedAt"
  );
  exactKeys(
    configuration.armExecutionOrder,
    [
      "algorithm",
      "mode",
      "models",
      "orderAssignments",
      "phasesPerArm",
      "scenarios",
      "variantsByScenario",
    ],
    "configuration.armExecutionOrder"
  );
  exact(
    configuration.armExecutionOrder.mode,
    "seeded-alternating-ab-ba",
    "configuration.armExecutionOrder.mode"
  );
  exact(
    configuration.armExecutionOrder.algorithm,
    EXPECTED_METHODOLOGY.armExecutionAlgorithm,
    "configuration.armExecutionOrder.algorithm"
  );
  exact(
    configuration.armExecutionOrder.models,
    EXPECTED_MODELS,
    "configuration.armExecutionOrder.models"
  );
  exact(
    configuration.armExecutionOrder.scenarios,
    SCENARIOS.map((scenario) => scenario.name),
    "configuration.armExecutionOrder.scenarios"
  );
  exact(
    configuration.armExecutionOrder.phasesPerArm,
    ["warmup", "settle", "measure"],
    "configuration.armExecutionOrder.phasesPerArm"
  );
  exact(
    configuration.armExecutionOrder.variantsByScenario,
    Object.fromEntries(
      SCENARIOS.map((scenario) => [scenario.name, scenarioVariants(scenario)])
    ),
    "configuration.armExecutionOrder.variantsByScenario"
  );
  const expectedAssignments = [];
  for (const model of EXPECTED_MODELS) {
    for (let trial = 1; trial <= EXPECTED_TRIALS; trial += 1) {
      for (const scenario of SCENARIOS) {
        const pairOrder = pairOrderFor(
          model,
          scenario.name,
          configuration.seed,
          trial
        );
        expectedAssignments.push({
          model,
          pairOrder,
          scenario: scenario.name,
          trial,
          variants: orderedVariants(scenario, pairOrder),
        });
      }
    }
  }
  denseArray(
    configuration.armExecutionOrder.orderAssignments,
    "configuration.armExecutionOrder.orderAssignments",
    EXPECTED_TOPOLOGY.orderAssignmentCount
  );
  for (const [
    index,
    assignment,
  ] of configuration.armExecutionOrder.orderAssignments.entries()) {
    exactKeys(
      assignment,
      ["model", "pairOrder", "scenario", "trial", "variants"],
      `configuration.armExecutionOrder.orderAssignments[${index}]`
    );
  }
  exact(
    configuration.armExecutionOrder.orderAssignments,
    expectedAssignments,
    "configuration.armExecutionOrder.orderAssignments"
  );
  check(
    typeof configuration.benchmarkSourceSha256 === "string" &&
      HASH_PATTERN.test(configuration.benchmarkSourceSha256),
    "configuration.benchmarkSourceSha256",
    "must be a lowercase SHA-256"
  );
  const runnerBytes = await readFile(
    resolve(repoRoot, "scripts/benchmark-cache-stable-tools.mts")
  );
  exact(
    configuration.benchmarkSourceSha256,
    sha256(runnerBytes),
    "configuration.benchmarkSourceSha256"
  );
  exact(
    configuration.benchmarkSourceSha256,
    frozenSourceManifest.get("scripts/benchmark-cache-stable-tools.mts"),
    "configuration.benchmarkSourceSha256.sourceFreezeCommit"
  );
  plainRecord(
    configuration.implementationSourcesSha256,
    "configuration.implementationSourcesSha256"
  );
  const manifestedPaths = Reflect.ownKeys(
    configuration.implementationSourcesSha256
  )
    .map(String)
    .sort();
  exact(
    manifestedPaths,
    [...REQUIRED_IMPLEMENTATION_SOURCE_PATHS].sort(),
    "configuration.implementationSourcesSha256.keys"
  );
  for (const sourcePath of REQUIRED_IMPLEMENTATION_SOURCE_PATHS) {
    check(
      !(sourcePath.startsWith("/") || sourcePath.split("/").includes("..")),
      `configuration.implementationSourcesSha256.${sourcePath}`,
      "must be repository-relative"
    );
    const hash = ownDescriptor(
      configuration.implementationSourcesSha256,
      sourcePath,
      "configuration.implementationSourcesSha256"
    );
    check(
      typeof hash === "string" && HASH_PATTERN.test(hash),
      `configuration.implementationSourcesSha256.${sourcePath}`,
      "must be a lowercase SHA-256"
    );
    exact(
      hash,
      sha256(await readFile(resolve(repoRoot, sourcePath))),
      `configuration.implementationSourcesSha256.${sourcePath}`
    );
    exact(
      hash,
      frozenSourceManifest.get(sourcePath),
      `configuration.implementationSourcesSha256.${sourcePath}.sourceFreezeCommit`
    );
  }
}

async function verifyEvidenceDocument({
  serialized,
  repoRoot,
  readmeText = null,
}) {
  const raw = serialized;
  check(
    typeof raw === "string",
    "evidence",
    "serialized evidence must be text"
  );
  const rawBytes = Buffer.byteLength(raw);
  check(
    rawBytes > 0 && rawBytes <= MAX_EVIDENCE_BYTES,
    "evidence",
    `serialized evidence must be 1-${MAX_EVIDENCE_BYTES} bytes`
  );
  check(
    !BEARER_PATTERN.test(raw),
    "evidence",
    "contains a bearer credential marker"
  );
  check(!KEY_LIKE_PATTERN.test(raw), "evidence", "contains a key-like value");
  let evidence;
  try {
    evidence = JSON.parse(raw);
  } catch {
    fail("evidence", "serialized evidence is not valid JSON");
  }
  check(
    !containsCredentialLikeString(evidence),
    "evidence",
    "contains a decoded credential-like string"
  );
  exactKeys(
    evidence,
    [
      "configuration",
      "credentialRecorded",
      "endpoint",
      "generatedAt",
      "interpretation",
      "models",
      "protocol",
      "responseIdAudit",
      "schemaVersion",
    ],
    "evidence"
  );
  exact(evidence.schemaVersion, 3, "evidence.schemaVersion");
  exact(evidence.endpoint, EXPECTED_ENDPOINT, "evidence.endpoint");
  exact(evidence.protocol, "openai-chat-completions", "evidence.protocol");
  exact(evidence.credentialRecorded, false, "evidence.credentialRecorded");
  const generatedAt = validTimestamp(
    evidence.generatedAt,
    "evidence.generatedAt"
  );
  exactKeys(
    evidence.interpretation,
    CACHE_REPORTING_STATUSES,
    "evidence.interpretation"
  );
  exact(
    evidence.interpretation,
    EXPECTED_INTERPRETATION,
    "evidence.interpretation"
  );
  check(
    findForbiddenKeys(evidence).length === 0,
    "evidence",
    `contains forbidden sanitized-schema keys: ${findForbiddenKeys(evidence).join(", ")}`
  );
  const root = resolve(
    repoRoot ?? dirname(dirname(fileURLToPath(import.meta.url)))
  );
  await verifyConfiguration(evidence.configuration, root);
  const preflightAt = validTimestamp(
    evidence.configuration.modelPreflight.checkedAt,
    "configuration.modelPreflight.checkedAt"
  );
  denseArray(evidence.models, "evidence.models", EXPECTED_MODELS.length);
  exact(
    evidence.models.map((model) => value(model, "model", "evidence.models[]")),
    EXPECTED_MODELS,
    "evidence.models[].model"
  );
  for (const [modelIndex, model] of evidence.models.entries()) {
    const path = `evidence.models[${modelIndex}]`;
    exactKeys(model, MODEL_KEYS, path);
    exact(model.model, EXPECTED_MODELS[modelIndex], `${path}.model`);
    denseArray(
      model.requests,
      `${path}.requests`,
      EXPECTED_TOPOLOGY.requestsPerModel
    );
  }
  const allRequests = evidence.models.flatMap((model) => model.requests);
  const campaignResponseIdDuplicateSets = responseIdDuplicateSets(allRequests);
  validateResponseIdAuditSchema(
    evidence.responseIdAudit,
    "evidence.responseIdAudit"
  );
  compareRecorded(
    evidence.responseIdAudit,
    deriveResponseIdAudit(allRequests),
    "evidence.responseIdAudit"
  );
  let previousCompletedAt = null;
  let firstStartedAt = null;
  let nextSequence = 0;
  const globalCanaries = new Set();
  for (const [modelIndex, model] of evidence.models.entries()) {
    const path = `evidence.models[${modelIndex}]`;
    const coordinates = expectedCoordinatesForModel(
      model.model,
      evidence.configuration.seed,
      nextSequence
    );
    for (const [requestIndex, request] of model.requests.entries()) {
      if (firstStartedAt === null) {
        firstStartedAt = validTimestamp(
          request.startedAt,
          `${path}.requests[${requestIndex}].startedAt`
        );
      }
      previousCompletedAt = verifyRequest(
        request,
        model.model,
        evidence.configuration,
        coordinates[requestIndex],
        previousCompletedAt,
        `${path}.requests[${requestIndex}]`
      );
      nextSequence += 1;
      check(
        !globalCanaries.has(request.isolationCanarySha256) ||
          request.phase === "measure",
        `${path}.requests[${requestIndex}].isolationCanarySha256`,
        "is reused by another arm"
      );
      if (request.phase === "warmup") {
        globalCanaries.add(request.isolationCanarySha256);
      }
    }
    verifyWarmupLinkage(
      model.requests,
      evidence.configuration.settleMs,
      `${path}.warmupLinkage`
    );
    validateRecordedViewSchemas(model, path);
    const expectedViews = deriveModelViews(
      model.requests,
      campaignResponseIdDuplicateSets
    );
    for (const [key, expectedView] of Object.entries(expectedViews)) {
      compareRecorded(model[key], expectedView, `${path}.${key}`);
    }
  }
  exact(
    nextSequence,
    EXPECTED_TOPOLOGY.totalRequests,
    "evidence.requestTopology.totalRequests"
  );
  exact(
    globalCanaries.size,
    EXPECTED_MODELS.length * EXPECTED_TOPOLOGY.armsPerModel,
    "evidence.isolationCanaries.uniqueArms"
  );
  check(
    firstStartedAt !== null && preflightAt <= firstStartedAt,
    "configuration.modelPreflight.checkedAt",
    "must not postdate the first benchmark request"
  );
  check(
    previousCompletedAt !== null && generatedAt >= previousCompletedAt,
    "evidence.generatedAt",
    "must not predate the final benchmark response"
  );
  check(
    generatedAt >= preflightAt,
    "evidence.generatedAt",
    "must not predate model preflight"
  );
  const report = buildReport(evidence, raw);
  const readmeBlock = renderReadmeBlock(report);
  if (readmeText !== null) {
    verifyReadme(readmeText, readmeBlock);
  }
  return { evidenceSha256: report.evidenceSha256, report, readmeBlock };
}

function parseCli(args) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const options = {
    evidence: resolve(
      repositoryRoot,
      "benchmarks/cache-stable-tools/latest-freerouter.json"
    ),
    readme: resolve(repositoryRoot, "benchmarks/cache-stable-tools/README.md"),
    repoRoot: repositoryRoot,
    printReadme: false,
    verifyReadme: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") {
      continue;
    }
    if (flag === "--print-readme") {
      options.printReadme = true;
      continue;
    }
    if (flag === "--no-readme") {
      options.verifyReadme = false;
      continue;
    }
    if (!["--evidence", "--readme", "--repo-root"].includes(flag)) {
      fail("cli", `unknown option ${flag}`);
    }
    const argument = args[index + 1];
    check(
      argument && !argument.startsWith("--"),
      "cli",
      `${flag} requires a value`
    );
    index += 1;
    if (flag === "--evidence") {
      options.evidence = resolve(argument);
    }
    if (flag === "--readme") {
      options.readme = resolve(argument);
    }
    if (flag === "--repo-root") {
      options.repoRoot = resolve(argument);
    }
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const serialized = await readRegularText(
    options.evidence,
    MAX_EVIDENCE_BYTES,
    "evidence"
  );
  const readmeText = options.verifyReadme
    ? await readRegularText(options.readme, MAX_README_BYTES, "README")
    : null;
  const result = await verifyEvidenceDocument({
    serialized,
    repoRoot: options.repoRoot,
    readmeText,
  });
  if (options.printReadme) {
    process.stdout.write(`${result.readmeBlock}\n`);
  } else {
    process.stdout.write(
      `Verified cache-stable evidence ${result.evidenceSha256} (${result.report.aggregate.observedRequests} requests).\n`
    );
  }
}

async function readRegularText(path, maximumBytes, label) {
  const metadata = await lstat(path);
  check(
    metadata.isFile() && !metadata.isSymbolicLink(),
    label,
    "must be a regular non-symlink file"
  );
  check(
    metadata.size > 0 && metadata.size <= maximumBytes,
    label,
    `must be 1-${maximumBytes} bytes`
  );
  return readFile(path, "utf8");
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

export {
  deriveModelViews,
  deriveResponseIdAudit,
  EvidenceVerificationError,
  EXPECTED_CAMPAIGN_ID,
  EXPECTED_MODELS,
  EXPECTED_TOPOLOGY,
  pairOrderFor,
  REQUIRED_IMPLEMENTATION_SOURCE_PATHS,
  renderReadmeBlock,
  requestArtifacts,
  responseIdDuplicateSets,
  SCENARIOS,
  verifyEvidenceDocument,
};
