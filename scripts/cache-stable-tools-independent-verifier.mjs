#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const EXPECTED_ENDPOINT = "https://freerouter.minpeter.workers.dev/v1";
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
const MINIMUM_ORDER_STRATUM_PAIRS = 3;
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
const CACHE_REPORTING_STATUSES = Object.freeze([
  "not-reported",
  "reported-nonzero",
  "reported-zero-only",
  "unavailable",
]);
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
const REQUIRED_IMPLEMENTATION_SOURCE_PATHS = Object.freeze([
  "package.json",
  "packages/runtime/package.json",
  "packages/runtime/src/llm/llm.ts",
  "packages/runtime/src/llm/model-step-preparation.ts",
  "packages/runtime/src/plugins/diagnostics.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/cache-stable-tools-evidence.test.mjs",
  "scripts/cache-stable-tools-independent-verifier.adversarial.mjs",
  "scripts/cache-stable-tools-independent-verifier.mjs",
  "scripts/cache-stable-tools-wire.test.mjs",
]);
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
  "startedAt",
  "success",
  "toolsArrayBytes",
  "toolsArraySha256",
  "totalTokens",
  "trial",
  "usageFieldAudit",
  "variant",
  "warmupPrerequisitePassed",
]);
const MODEL_KEYS = Object.freeze([
  "cacheReporting",
  "cacheWriteReporting",
  "comparisons",
  "finishReasonAudit",
  "isolationAudit",
  "membershipInputTokenParityAudit",
  "model",
  "outputComplianceAudit",
  "requestOutcomeAudit",
  "requests",
  "responseModelAudit",
  "summaries",
  "usageFieldStatusAudit",
]);
const PAIRED_SUMMARY_KEYS = Object.freeze([
  "cacheReadTokenDifferenceSigns",
  "eligiblePairs",
  "inputTokenDifferenceSigns",
  "medianControlMinusChangedCacheReadRatio",
  "medianControlMinusChangedCacheReadTokens",
  "medianControlMinusChangedInputTokens",
  "medianControlMinusChangedLatencyMs",
  "p25ControlMinusChangedCacheReadRatio",
  "p25ControlMinusChangedCacheReadTokens",
  "p25ControlMinusChangedInputTokens",
  "p75ControlMinusChangedCacheReadRatio",
  "p75ControlMinusChangedCacheReadTokens",
  "p75ControlMinusChangedInputTokens",
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
  "controlMinusChangedInputTokens",
  "controlMinusChangedLatencyMs",
  "pairOrder",
  "trial",
]);
const VARIANT_SUMMARY_KEYS = Object.freeze([
  "attempts",
  "cacheReadNonzero",
  "cacheReadNonzeroCoverage",
  "cacheReadReported",
  "cacheReportCoverage",
  "cacheTelemetryEligible",
  "cacheWriteNonzero",
  "cacheWriteNonzeroCoverage",
  "cacheWriteReported",
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
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/u;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[\w.-]{1,80}$/u;
const KEY_LIKE_PATTERN = /\bfr-[\w-]{8,}\b/u;
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

function isolationTokenFor(model, runId, scenario, trial, variant) {
  return sha256(`${runId}\0${model}\0${scenario}\0${variant}\0${trial}`).slice(
    0,
    24
  );
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

function finishReasonsAccepted(statuses) {
  return (
    Array.isArray(statuses) &&
    statuses.length > 0 &&
    statuses.every((status) => status === "accepted-stop")
  );
}

function expectedCaptureOutcome(request) {
  if (!request.httpSuccess) {
    return { success: false, errorCodeKind: "http" };
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
      : [pair.controlCacheReadRatio - pair.changedCacheReadRatio]
  );
  return {
    eligiblePairs: pairs.length,
    medianControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.5),
    p25ControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.25),
    p75ControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.75),
    cacheReadTokenDifferenceSigns: differenceSigns(cacheDifferences),
    inputTokenDifferenceSigns: differenceSigns(inputDifferences),
    medianControlMinusChangedInputTokens: quantile(inputDifferences, 0.5),
    p25ControlMinusChangedInputTokens: quantile(inputDifferences, 0.25),
    p75ControlMinusChangedInputTokens: quantile(inputDifferences, 0.75),
    medianControlMinusChangedLatencyMs: quantile(latencyDifferences, 0.5),
    medianControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.5),
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

function buildPairs(requests, scenario) {
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
        cacheMeasurementIsValid(changed)
      )
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
    });
  }
  return pairs;
}

function deriveComparisons(requests) {
  return SCENARIOS.map((scenario) => {
    const pairs = buildPairs(requests, scenario);
    return {
      scenario: scenario.name,
      controlVariant: scenario.controlVariant,
      changedVariant: scenario.changedVariant,
      ...summarizePairs(pairs),
      orderStrata: PAIR_ORDERS.map((pairOrder) => ({
        pairOrder,
        ...summarizePairs(pairs.filter((pair) => pair.pairOrder === pairOrder)),
      })),
      pairs,
    };
  });
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

function deriveMembershipParity(requests) {
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
  return {
    changedHigher: differences.filter((difference) => difference < 0).length,
    controlHigher: differences.filter((difference) => difference > 0).length,
    eligiblePairs: pairs.length,
    equal: differences.filter((difference) => difference === 0).length,
    missingPairs: EXPECTED_TRIALS - pairs.length,
    pairs,
  };
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
    captureSuccesses: requests.filter((request) => request.success).length,
    cacheReadReported: cacheReported.length,
    cacheReportCoverage:
      eligible.length === 0 ? null : cacheReported.length / eligible.length,
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
    warmupCount: warmups.length,
    unexpectedToolCallResponseCount: requests.filter(
      (request) => (request.responseToolCallCount ?? 0) > 0
    ).length,
  };
}

function deriveModelViews(requests) {
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
    cacheReporting: reportingStatus(requests, "read"),
    cacheWriteReporting: reportingStatus(requests, "write"),
    comparisons: deriveComparisons(requests),
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
  if (outcome.errorCodeKind === "http") {
    check(
      typeof request.errorCode === "string" &&
        SAFE_ERROR_CODE_PATTERN.test(request.errorCode),
      `${path}.errorCode`,
      "must retain a safe HTTP error code"
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
    request.variant
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

function verifyWarmupLinkage(requests, path) {
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
  denseArray(model.comparisons, `${path}.comparisons`, SCENARIOS.length);
  for (const [index, comparison] of model.comparisons.entries()) {
    exactKeys(
      comparison,
      [
        "scenario",
        "controlVariant",
        "changedVariant",
        ...PAIRED_SUMMARY_KEYS,
        "orderStrata",
        "pairs",
      ],
      `${path}.comparisons[${index}]`
    );
    denseArray(
      comparison.orderStrata,
      `${path}.comparisons[${index}].orderStrata`,
      2
    );
    for (const [stratumIndex, stratum] of comparison.orderStrata.entries()) {
      exactKeys(
        stratum,
        ["pairOrder", ...PAIRED_SUMMARY_KEYS],
        `${path}.comparisons[${index}].orderStrata[${stratumIndex}]`
      );
    }
    denseArray(comparison.pairs, `${path}.comparisons[${index}].pairs`);
    for (const [pairIndex, pair] of comparison.pairs.entries()) {
      exactKeys(
        pair,
        PAIR_KEYS,
        `${path}.comparisons[${index}].pairs[${pairIndex}]`
      );
    }
  }
  denseArray(model.summaries, `${path}.summaries`, SCENARIOS.length * 2);
  for (const [index, summary] of model.summaries.entries()) {
    exactKeys(
      summary,
      ["scenario", "variant", ...VARIANT_SUMMARY_KEYS],
      `${path}.summaries[${index}]`
    );
  }
  exactKeys(
    model.membershipInputTokenParityAudit,
    [
      "changedHigher",
      "controlHigher",
      "eligiblePairs",
      "equal",
      "missingPairs",
      "pairs",
    ],
    `${path}.membershipInputTokenParityAudit`
  );
  denseArray(
    model.membershipInputTokenParityAudit.pairs,
    `${path}.membershipInputTokenParityAudit.pairs`
  );
  for (const [
    index,
    pair,
  ] of model.membershipInputTokenParityAudit.pairs.entries()) {
    exactKeys(
      pair,
      [
        "changedInputTokens",
        "controlInputTokens",
        "controlMinusChangedInputTokens",
        "pairOrder",
        "trial",
      ],
      `${path}.membershipInputTokenParityAudit.pairs[${index}]`
    );
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
  minimumPairs = MINIMUM_ORDER_STRATUM_PAIRS
) {
  const summarized = PAIR_ORDERS.map((pairOrder) => {
    const stratum = strata.find((item) => item.pairOrder === pairOrder);
    return {
      pairOrder,
      eligiblePairs: stratum?.eligiblePairs ?? 0,
      median: stratum?.[medianField] ?? null,
      direction: direction(stratum?.[medianField] ?? null),
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

function effectForComparison(
  comparison,
  minimumPairs = MINIMUM_ORDER_STRATUM_PAIRS
) {
  return classifyOrderStrata(
    comparison.orderStrata,
    "medianControlMinusChangedCacheReadTokens",
    {
      "control-higher": "descriptive-control-higher-cache-read",
      "changed-higher": "descriptive-changed-higher-cache-read",
      equal: "no-observed-cache-read-difference",
      unavailable: "insufficient-coverage",
    },
    minimumPairs
  );
}

function membershipEffect(parity, minimumPairs = MINIMUM_ORDER_STRATUM_PAIRS) {
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
  }, minimumPairs);
  return classifyOrderStrata(strata, "medianControlMinusChangedInputTokens", {
    "control-higher": "descriptive-control-higher-input",
    "changed-higher": "descriptive-changed-higher-input",
    equal: "input-token-parity",
    unavailable: "insufficient-coverage",
  });
}

function pooledComparison(models, scenario) {
  const pairs = models.flatMap((model) => {
    const comparison = deriveComparisons(model.requests).find(
      (item) => item.scenario === scenario.name
    );
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

function buildReport(evidence, serialized) {
  const allRequests = evidence.models.flatMap((model) => model.requests);
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
  }));
  const effects = evidence.models.flatMap((model) =>
    deriveComparisons(model.requests).map((comparison) => ({
      scope: model.model,
      scenario: comparison.scenario,
      ...effectForComparison(comparison),
    }))
  );
  for (const scenario of SCENARIOS) {
    const comparison = pooledComparison(evidence.models, scenario);
    effects.push({
      scope: "pooled",
      scenario: scenario.name,
      ...effectForComparison(
        comparison,
        EXPECTED_MODELS.length * MINIMUM_ORDER_STRATUM_PAIRS
      ),
    });
  }
  const membershipInputParity = evidence.models.map((model) => ({
    scope: model.model,
    ...membershipEffect(deriveMembershipParity(model.requests)),
  }));
  const pooledParityPairs = evidence.models.flatMap((model) =>
    deriveMembershipParity(model.requests).pairs.map((pair) => ({
      ...pair,
      model: model.model,
    }))
  );
  membershipInputParity.push({
    scope: "pooled",
    ...membershipEffect(
      { pairs: pooledParityPairs },
      EXPECTED_MODELS.length * MINIMUM_ORDER_STRATUM_PAIRS
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

async function verifyConfiguration(configuration, repoRoot) {
  exactKeys(
    configuration,
    [
      "armExecutionOrder",
      "armIsolation",
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
      "runId",
      "seed",
      "settleMs",
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
    0.75,
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
  for (const key of [
    "effectConclusionPolicy",
    "toolCallValidation",
    "outputValidation",
    "pairedUncertainty",
    "usageValidation",
  ]) {
    check(
      typeof configuration[key] === "string" && configuration[key].length > 0,
      `configuration.${key}`,
      "must be nonempty text"
    );
  }
  exactKeys(
    configuration.armIsolation,
    ["canary", "promptNamespace"],
    "configuration.armIsolation"
  );
  exactKeys(
    configuration.eligibilitySemantics,
    ["cacheTelemetryEligible", "captureSuccess"],
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
  exactKeys(
    configuration.comparisonSemantics,
    SCENARIOS.map((scenario) => scenario.name),
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
  }
}

async function verifyEvidenceDocument({
  evidence,
  serialized,
  repoRoot,
  readmeText = null,
}) {
  const raw = serialized ?? `${JSON.stringify(evidence, null, 2)}\n`;
  check(
    typeof raw === "string",
    "evidence",
    "serialized evidence must be text"
  );
  check(
    !BEARER_PATTERN.test(raw),
    "evidence",
    "contains a bearer credential marker"
  );
  check(!KEY_LIKE_PATTERN.test(raw), "evidence", "contains a key-like value");
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
      "schemaVersion",
    ],
    "evidence"
  );
  exact(evidence.schemaVersion, 3, "evidence.schemaVersion");
  exact(evidence.endpoint, EXPECTED_ENDPOINT, "evidence.endpoint");
  exact(evidence.protocol, "openai-chat-completions", "evidence.protocol");
  exact(evidence.credentialRecorded, false, "evidence.credentialRecorded");
  validTimestamp(evidence.generatedAt, "evidence.generatedAt");
  exactKeys(
    evidence.interpretation,
    CACHE_REPORTING_STATUSES,
    "evidence.interpretation"
  );
  for (const status of CACHE_REPORTING_STATUSES) {
    check(
      typeof evidence.interpretation[status] === "string" &&
        evidence.interpretation[status].length > 0,
      `evidence.interpretation.${status}`,
      "must be nonempty text"
    );
  }
  check(
    findForbiddenKeys(evidence).length === 0,
    "evidence",
    `contains forbidden sanitized-schema keys: ${findForbiddenKeys(evidence).join(", ")}`
  );
  const root = resolve(
    repoRoot ?? dirname(dirname(fileURLToPath(import.meta.url)))
  );
  await verifyConfiguration(evidence.configuration, root);
  denseArray(evidence.models, "evidence.models", EXPECTED_MODELS.length);
  exact(
    evidence.models.map((model) => value(model, "model", "evidence.models[]")),
    EXPECTED_MODELS,
    "evidence.models[].model"
  );
  let previousCompletedAt = null;
  let nextSequence = 0;
  const globalCanaries = new Set();
  for (const [modelIndex, model] of evidence.models.entries()) {
    const path = `evidence.models[${modelIndex}]`;
    exactKeys(model, MODEL_KEYS, path);
    exact(model.model, EXPECTED_MODELS[modelIndex], `${path}.model`);
    denseArray(
      model.requests,
      `${path}.requests`,
      EXPECTED_TOPOLOGY.requestsPerModel
    );
    const coordinates = expectedCoordinatesForModel(
      model.model,
      evidence.configuration.seed,
      nextSequence
    );
    for (const [requestIndex, request] of model.requests.entries()) {
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
    verifyWarmupLinkage(model.requests, `${path}.warmupLinkage`);
    validateRecordedViewSchemas(model, path);
    const expectedViews = deriveModelViews(model.requests);
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
  const serialized = await readFile(options.evidence, "utf8");
  let evidence;
  try {
    evidence = JSON.parse(serialized);
  } catch {
    fail("evidence", "is not valid JSON");
  }
  const readmeText = options.verifyReadme
    ? await readFile(options.readme, "utf8")
    : null;
  const result = await verifyEvidenceDocument({
    evidence,
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
  EvidenceVerificationError,
  EXPECTED_CAMPAIGN_ID,
  EXPECTED_MODELS,
  EXPECTED_TOPOLOGY,
  pairOrderFor,
  REQUIRED_IMPLEMENTATION_SOURCE_PATHS,
  renderReadmeBlock,
  requestArtifacts,
  SCENARIOS,
  verifyEvidenceDocument,
};
