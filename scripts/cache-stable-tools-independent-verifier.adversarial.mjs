import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveModelViews,
  EXPECTED_CAMPAIGN_ID,
  EXPECTED_MODELS,
  EXPECTED_TOPOLOGY,
  pairOrderFor,
  REQUIRED_IMPLEMENTATION_SOURCE_PATHS,
  requestArtifacts,
  SCENARIOS,
  verifyEvidenceDocument,
} from "./cache-stable-tools-independent-verifier.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const TIMESTAMP = "2026-07-17T00:00:00.000Z";
const REQUEST_SPACING_MS = 2000;
const STATIC_IMPORT_DECLARATION_PATTERN = /^\s*import(?!\s*\()[\s\S]*?;\s*$/gmu;
const IMPORT_FROM_SPECIFIER_PATTERN = /\bfrom\s+["']([^"']+)["']/u;
const IMPORT_SIDE_EFFECT_SPECIFIER_PATTERN = /^\s*import\s+["']([^"']+)["']/u;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/u;
const DECODED_CREDENTIAL_PATTERN = /decoded credential-like string/u;
const OVERSIZED_EVIDENCE_PATTERN = /1-10000000 bytes/u;
const EXPECTED_VERIFIER_IMPORTS = [
  "node:crypto",
  "node:fs/promises",
  "node:path",
  "node:url",
  "node:util",
];
const MANUAL_INTERPRETATION = {
  "not-reported":
    "Successful responses did not expose a recognized cache-read usage field; this does not prove that no provider-side cache exists.",
  "reported-nonzero":
    "At least one measured response exposed a positive provider-reported cache-read token count.",
  "reported-zero-only":
    "A recognized cache-read usage field was exposed, but every measured value was zero.",
  unavailable:
    "No measured request passed response-model and usage-envelope eligibility.",
};
const MANUAL_METHODOLOGY = {
  armExecutionAlgorithm:
    "A SHA-256 bit of seed, model, and scenario selects the first trial order; each later trial alternates it. Even trial counts are exactly balanced.",
  armIsolation: {
    canary:
      "Each arm has a unique, fixed-length token in an equal-shape inert canary placed before every benchmark tool. Warmup and measure reuse the same canary; no other arm does.",
    promptNamespace:
      "Each arm has a unique, fixed-length system-message namespace shared only by its warmup and measurement.",
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
    "A model-level directional cache or input-token conclusion is reported only when each AB/BA order stratum retains at least 75% eligible pairs and both stratum medians have the same nonzero sign. A pooled conclusion additionally requires at least three complete pairs in every model-by-order stratum. Two zero medians report no observed median difference; mixed signs or a zero/nonzero mix report order-sensitive; missing coverage is indeterminate.",
  eligibilitySemantics: {
    cacheTelemetryEligible:
      "A capture-success request is locally eligible for requested-model cache aggregation only when the sanitized response model exactly matches the requested model and input/cache-read/cache-write usage aliases form a valid envelope. A measured request additionally requires its own arm's warmup to be a capture success from that exact requested model.",
    captureSuccess:
      "HTTP success plus exactly one recognized choice/message, zero modern or legacy tool calls, finish_reason=stop, and exact trimmed text OK. Response-model attribution and usage validity are audited separately.",
  },
  finishReasonPolicy:
    "The sole choice must report finish_reason=stop for capture success. Missing, accessor-backed, non-string, unknown, length, content_filter, function_call, and tool_calls values are stored only as sanitized status labels and fail closed; raw finish-reason values are never stored.",
  outputValidation:
    "The result stores only whether the sole choice returned exact trimmed text OK; response text and tool arguments are never stored. Missing, malformed, multi-choice, and mismatched output fails capture and therefore cache-telemetry eligibility.",
  pairedUncertainty:
    "Paired summaries include descriptive p25/p75 intervals and effect signs overall and by AB/BA order. These are not confidence intervals.",
  sourceSnapshotSemantics:
    "The runner records on-disk source snapshots after module initialization and again before atomic rename. A start/end mismatch fails. Transient edit-and-restore and changes between module load and the initial snapshot are not detected, so the campaign requires a quiescent worktree.",
  toolCallValidation:
    "Every HTTP-success response must contain a recognized choices array and zero tool calls; otherwise the request is marked unsuccessful.",
  usageValidation:
    "Cache aggregates accept only nonnegative safe-integer input/read/write token observations. Read and write must each be no greater than input, their sum must be a safe integer no greater than input, and every cross-request sum must remain a safe integer or the campaign fails closed without evidence. Conflicting or malformed aliases retain only an audit status; their source and value are nulled instead of guessed or clamped. Output and total-token audit conflicts do not affect cache-read eligibility.",
};

let pristine;

test("independent verifier has no producer-module dependency", async () => {
  const source = await readFile(
    resolve(
      REPOSITORY_ROOT,
      "scripts/cache-stable-tools-independent-verifier.mjs"
    ),
    "utf8"
  );
  assert.deepEqual(staticImportSpecifiers(source), EXPECTED_VERIFIER_IMPORTS);
  assert.doesNotMatch(source, DYNAMIC_IMPORT_PATTERN);
});

test("pins manual topology and request-artifact oracles", () => {
  assert.equal(
    pairOrderFor(
      "minimaxai/minimax-m2.7",
      "same-set-order",
      EXPECTED_CAMPAIGN_ID,
      1
    ),
    "control-first"
  );
  assert.equal(
    pairOrderFor(
      "minimaxai/minimax-m2.7",
      "same-set-order",
      EXPECTED_CAMPAIGN_ID,
      2
    ),
    "changed-first"
  );
  assert.deepEqual(
    requestArtifacts({
      isolationToken: "0123456789abcdef01234567",
      model: "minimaxai/minimax-m2.7",
      prefixLines: 700,
      toolNames: SCENARIOS[0].warmupTools,
    }),
    {
      isolationCanarySha256:
        "09c0437451fd8fb8efed99eaa291d91c204b3abfdb628782fd55c34f2ccfdff0",
      requestBodyBytes: 100_612,
      requestBodySha256:
        "40069f8749e34a71522a821cc7718be4a7d872c0c779447811ad5bd781e6e408",
      toolsArrayBytes: 21_118,
      toolsArraySha256:
        "011ee0de97c3f67c6103bfc1b3d39ccf9b55f87da7a277532eec9c53fc23a76e",
    }
  );
});

test("accepts a complete synthetic 480-request schema-v3 campaign", async () => {
  pristine ??= await syntheticEvidence();
  const result = await verify(pristine);

  assert.equal(result.report.aggregate.expectedRequests, 480);
  assert.equal(result.report.aggregate.observedRequests, 480);
  assert.equal(result.report.aggregate.captureSuccess, 480);
  assert.equal(result.report.models.length, 5);
  assert.equal(result.report.effects.length, 18);
  assert.equal(
    result.report.effects.find(
      (effect) =>
        effect.scope === EXPECTED_MODELS[0] &&
        effect.scenario === "same-set-order"
    ).conclusion,
    "descriptive-control-higher-cache-read"
  );
  assert.equal(
    result.report.membershipInputParity.find(
      (effect) => effect.scope === EXPECTED_MODELS[0]
    ).conclusion,
    "input-token-parity"
  );

  const readme = `# Synthetic evidence\n\n${result.readmeBlock}\n`;
  await verify(pristine, readme);
});

test("rejects legacy schema-v2 evidence before interpreting it", async () => {
  const evidence = await copyPristine();
  evidence.schemaVersion = 2;
  await rejectsWith(evidence, ["schemaVersion"]);
});

test("rejects a source manifest hash that is not backed by current bytes", async () => {
  const evidence = await copyPristine();
  evidence.configuration.implementationSourcesSha256[
    "packages/runtime/src/llm/llm.ts"
  ] = "0".repeat(64);
  await rejectsWith(evidence, ["implementationSourcesSha256"]);
});

test("rejects topology truncation", async () => {
  const evidence = await copyPristine();
  evidence.models[4].requests.pop();
  await rejectsWith(evidence, ["requests", "length"]);
});

test("rejects a forged AB/BA assignment", async () => {
  const evidence = await copyPristine();
  const assignment =
    evidence.configuration.armExecutionOrder.orderAssignments[0];
  assignment.pairOrder =
    assignment.pairOrder === "control-first"
      ? "changed-first"
      : "control-first";
  await rejectsWith(evidence, ["orderAssignments"]);
});

test("rejects request reordering and coordinate forgery", async () => {
  const evidence = await copyPristine();
  [evidence.models[0].requests[0], evidence.models[0].requests[1]] = [
    evidence.models[0].requests[1],
    evidence.models[0].requests[0],
  ];
  await rejectsWith(evidence, ["phase"]);
});

test("rejects non-sequential timestamps even when coordinates are intact", async () => {
  const evidence = await copyPristine();
  evidence.models[0].requests[1].startedAt = "2026-07-16T23:59:59.999Z";
  await rejectsWith(evidence, ["chronology"]);
});

test("binds model preflight and generation to the request timeline", async () => {
  const latePreflight = await copyPristine();
  latePreflight.configuration.modelPreflight.checkedAt =
    "2026-07-17T00:00:02.001Z";
  await rejectsWith(latePreflight, ["modelPreflight", "postdate"]);

  const earlyGeneration = await copyPristine();
  earlyGeneration.generatedAt = "2026-07-16T23:59:59.999Z";
  await rejectsWith(earlyGeneration, ["generatedAt", "predate"]);
});

test("rejects a measured request without the configured monotonic settle", async () => {
  const evidence = await copyPristine();
  const measured = evidence.models[0].requests.find(
    (request) => request.phase === "measure"
  );
  measured.settleElapsedMs = evidence.configuration.settleMs - 1;
  await rejectsWith(evidence, ["settleElapsedMs", "at least"]);
});

test("binds the recorded settle to the warmup and measurement timeline", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const measured = model.requests.find(
    (request) => request.phase === "measure"
  );
  const warmup = model.requests.find(
    (request) =>
      request.phase === "warmup" &&
      request.scenario === measured.scenario &&
      request.trial === measured.trial &&
      request.variant === measured.variant
  );
  measured.startedAt = warmup.completedAt;
  await rejectsWith(evidence, ["measure.startedAt", "after warmup"]);
});

test("treats serialized bytes as the sole authority without inspecting an object", async () => {
  const evidence = await copyPristine();
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  let trapCalls = 0;
  const ignoredObject = new Proxy(evidence, {
    get() {
      trapCalls += 1;
      throw new Error("untrusted object getter must stay inert");
    },
    ownKeys() {
      trapCalls += 1;
      throw new Error("untrusted object ownKeys must stay inert");
    },
  });
  const result = await verifyEvidenceDocument({
    evidence: ignoredObject,
    serialized,
    repoRoot: REPOSITORY_ROOT,
  });
  assert.equal(result.report.aggregate.observedRequests, 480);
  assert.equal(trapCalls, 0);
});

test("rejects oversized serialized evidence before parsing", async () => {
  await assert.rejects(
    () =>
      verifyEvidenceDocument({
        serialized: " ".repeat(10_000_001),
        repoRoot: REPOSITORY_ROOT,
      }),
    OVERSIZED_EVIDENCE_PATTERN
  );
});

test("rejects credential markers hidden behind JSON escapes", async () => {
  const evidence = await copyPristine();
  evidence.configuration.nodeVersion = "Bearer synthetic-secret";
  const serialized = `${JSON.stringify(evidence, null, 2).replace(
    "Bearer synthetic-secret",
    "Bearer\\u0020synthetic-secret"
  )}\n`;
  await assert.rejects(
    () =>
      verifyEvidenceDocument({
        serialized,
        repoRoot: REPOSITORY_ROOT,
      }),
    DECODED_CREDENTIAL_PATTERN
  );
});

test("rejects methodology and interpretation prose tampering", async () => {
  const methodology = await copyPristine();
  methodology.configuration.eligibilitySemantics.captureSuccess =
    "Any response is accepted.";
  await rejectsWith(methodology, ["eligibilitySemantics"]);

  const interpretation = await copyPristine();
  interpretation.interpretation["not-reported"] =
    "Missing cache telemetry proves there was no cache.";
  await rejectsWith(interpretation, ["interpretation"]);
});

test("rejects raw or unexpected request fields", async () => {
  const evidence = await copyPristine();
  evidence.models[0].requests[0].content = "raw provider text";
  await rejectsWith(evidence, ["forbidden sanitized-schema keys"]);
});

test("rejects a cache-eligible request with an invalid usage envelope", async () => {
  const evidence = await copyPristine();
  evidence.models[0].requests[0].cacheReadTokens = 101;
  await rejectsWith(evidence, ["cacheTelemetryEligible"]);
});

test("rejects a forged warmup prerequisite", async () => {
  const evidence = await copyPristine();
  const measured = evidence.models[0].requests.find(
    (request) => request.phase === "measure"
  );
  measured.warmupPrerequisitePassed = false;
  measured.cacheTelemetryEligible = false;
  await rejectsWith(evidence, ["warmupPrerequisitePassed"]);
});

test("rejects a producer-authored paired effect summary tamper", async () => {
  const evidence = await copyPristine();
  evidence.models[0].comparisons[0].medianControlMinusChangedCacheReadTokens += 1;
  await rejectsWith(evidence, ["comparisons", "independent recomputation"]);
});

test("rejects a membership parity audit tamper", async () => {
  const evidence = await copyPristine();
  evidence.models[0].membershipInputTokenParityAudit.equal -= 1;
  await rejectsWith(evidence, [
    "membershipInputTokenParityAudit",
    "independent recomputation",
  ]);
});

test("rejects a weighted aggregate tamper", async () => {
  const evidence = await copyPristine();
  evidence.models[0].summaries[0].weightedCacheReadRatio = 0.123;
  await rejectsWith(evidence, ["summaries", "independent recomputation"]);
});

test("fails closed when a cross-request token sum overflows", async () => {
  const evidence = await copyPristine();
  const requests = evidence.models[0].requests.filter(
    (request) =>
      request.phase === "measure" && request.variant === "stable-order"
  );
  for (const request of requests.slice(0, 2)) {
    request.inputTokens = Number.MAX_SAFE_INTEGER;
    request.cacheReadTokens = Number.MAX_SAFE_INTEGER;
    request.cacheWriteTokens = 0;
    request.outputTokens = 0;
    request.totalTokens = Number.MAX_SAFE_INTEGER;
  }
  await rejectsWith(evidence, ["sum overflow"]);
});

test("withholds a directional effect below three complete pairs per order", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const targetTrials = trialsForOrder(
    model.model,
    "same-set-order",
    "control-first"
  ).slice(0, 2);
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      request.scenario === "same-set-order" &&
      targetTrials.includes(request.trial)
    ) {
      request.usageFieldAudit.cacheRead = "absent";
      request.cacheReadTokens = null;
      request.cacheReadSource = null;
    }
  }
  refreshModel(model);
  const result = await verify(evidence);
  assert.equal(
    result.report.effects.find(
      (effect) =>
        effect.scope === model.model && effect.scenario === "same-set-order"
    ).conclusion,
    "insufficient-coverage"
  );
});

test("withholds membership parity below three complete pairs per order", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const targetTrials = trialsForOrder(
    model.model,
    "membership-only-change",
    "control-first"
  ).slice(0, 2);
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      request.scenario === "membership-only-change" &&
      targetTrials.includes(request.trial)
    ) {
      request.cacheReadSource = null;
      request.cacheReadTokens = null;
      request.cacheTelemetryEligible = false;
      request.cacheWriteSource = null;
      request.cacheWriteTokens = null;
      request.inputSource = null;
      request.inputTokens = null;
      request.usageFieldAudit.cacheRead = "absent";
      request.usageFieldAudit.cacheWrite = "absent";
      request.usageFieldAudit.input = "absent";
    }
  }
  refreshModel(model);
  const result = await verify(evidence);
  assert.equal(
    result.report.membershipInputParity.find(
      (effect) => effect.scope === model.model
    ).conclusion,
    "insufficient-coverage"
  );
});

test("requires every model-by-order stratum for pooled conclusions", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      ["membership-only-change", "same-set-order"].includes(request.scenario)
    ) {
      request.responseModel = "synthetic/mismatched-model";
      request.responseModelMatchesRequested = false;
      request.cacheTelemetryEligible = false;
    }
  }
  refreshModel(model);
  const result = await verify(evidence);
  assert.equal(
    result.report.membershipInputParity.find(
      (effect) => effect.scope === "pooled"
    ).conclusion,
    "insufficient-coverage"
  );
  assert.equal(
    result.report.effects.find(
      (effect) =>
        effect.scope === "pooled" && effect.scenario === "same-set-order"
    ).conclusion,
    "insufficient-coverage"
  );
});

test("classifies opposite AB and BA directions as order-sensitive", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      request.scenario === "same-set-order" &&
      request.pairOrder === "changed-first"
    ) {
      request.cacheReadTokens = request.variant === "stable-order" ? 20 : 80;
    }
  }
  refreshModel(model);
  const result = await verify(evidence);
  assert.equal(
    result.report.effects.find(
      (effect) =>
        effect.scope === model.model && effect.scenario === "same-set-order"
    ).conclusion,
    "order-sensitive/indeterminate"
  );
});

test("rejects README figures that differ from independently derived output", async () => {
  const evidence = await copyPristine();
  const result = await verify(evidence);
  const readme = `# Synthetic evidence\n\n${result.readmeBlock.replace(
    '"observedRequests": 480',
    '"observedRequests": 479'
  )}\n`;
  await rejectsWith(evidence, ["README.snapshot"], readme);
});

async function copyPristine() {
  pristine ??= await syntheticEvidence();
  return structuredClone(pristine);
}

function verify(evidence, readmeText = null) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  return verifyEvidenceDocument({
    serialized,
    repoRoot: REPOSITORY_ROOT,
    readmeText,
  });
}

async function rejectsWith(evidence, fragments, readmeText = null) {
  await assert.rejects(
    () => verify(evidence, readmeText),
    (error) =>
      error instanceof Error &&
      fragments.every((fragment) => error.message.includes(fragment))
  );
}

async function syntheticEvidence() {
  const configuration = await syntheticConfiguration();
  const counter = { value: 0 };
  const models = EXPECTED_MODELS.map((modelName) =>
    syntheticModel(modelName, counter)
  );

  assert.equal(counter.value, EXPECTED_TOPOLOGY.totalRequests);
  return {
    configuration,
    credentialRecorded: false,
    endpoint: "https://freerouter.minpeter.workers.dev/v1",
    generatedAt: requestTimestamp(EXPECTED_TOPOLOGY.totalRequests + 1),
    interpretation: MANUAL_INTERPRETATION,
    models,
    protocol: "openai-chat-completions",
    schemaVersion: 3,
  };
}

function syntheticModel(modelName, counter) {
  const requests = [];
  for (let trial = 1; trial <= 8; trial += 1) {
    for (const scenario of SCENARIOS) {
      requests.push(
        ...syntheticScenarioRequests(modelName, trial, scenario, counter)
      );
    }
  }
  const model = { model: modelName, requests };
  refreshModel(model);
  return model;
}

function syntheticScenarioRequests(modelName, trial, scenario, counter) {
  const pairOrder = pairOrderFor(
    modelName,
    scenario.name,
    EXPECTED_CAMPAIGN_ID,
    trial
  );
  const variants =
    pairOrder === "control-first"
      ? [scenario.controlVariant, scenario.changedVariant]
      : [scenario.changedVariant, scenario.controlVariant];
  return variants.flatMap((variant, armIndex) =>
    syntheticArmRequests({
      armIndex,
      counter,
      modelName,
      pairOrder,
      scenario,
      trial,
      variant,
    })
  );
}

function syntheticArmRequests({
  armIndex,
  counter,
  modelName,
  pairOrder,
  scenario,
  trial,
  variant,
}) {
  const isolationToken = sha256(
    `${RUN_ID}\0${modelName}\0${scenario.name}\0${variant}\0${trial}`
  ).slice(0, 24);
  return ["warmup", "measure"].map((phase) => {
    counter.value += 1;
    const isControl = variant === scenario.controlVariant;
    const toolNames =
      phase === "warmup"
        ? scenario.warmupTools
        : scenario.measuredTools[variant];
    return syntheticRequest({
      armIndex,
      artifacts: requestArtifacts({
        isolationToken,
        model: modelName,
        prefixLines: 700,
        toolNames,
      }),
      isControl,
      modelName,
      pairOrder,
      phase,
      requestSequence: counter.value,
      scenarioName: scenario.name,
      trial,
      variant,
    });
  });
}

function syntheticRequest({
  armIndex,
  artifacts,
  isControl,
  modelName,
  pairOrder,
  phase,
  requestSequence,
  scenarioName,
  trial,
  variant,
}) {
  let cacheReadTokens = 50;
  let latencyMs = 5;
  if (phase === "measure") {
    cacheReadTokens = isControl ? 80 : 40;
    latencyMs = isControl ? 10 : 20;
  }
  return {
    armPosition: armIndex === 0 ? "first" : "second",
    cacheReadSource: "prompt_tokens_details.cached_tokens",
    cacheReadTokens,
    cacheTelemetryEligible: true,
    cacheWriteSource: "prompt_tokens_details.cache_write_tokens",
    cacheWriteTokens: 0,
    completedAt: requestTimestamp(requestSequence, 25),
    errorCode: null,
    httpStatus: 200,
    httpSuccess: true,
    inputSource: "prompt_tokens",
    inputTokens: 100,
    ...artifacts,
    latencyMs,
    outputTokens: 1,
    outputWasExactOk: true,
    pairOrder,
    phase,
    requestSequence,
    responseFinishReasonStatuses: ["accepted-stop"],
    responseIdSha256: sha256(
      `${modelName}:${scenarioName}:${trial}:${variant}:${phase}`
    ),
    responseModel: modelName,
    responseModelMatchesRequested: true,
    responseToolCallCount: 0,
    scenario: scenarioName,
    settleElapsedMs: phase === "warmup" ? null : 1500,
    startedAt: requestTimestamp(requestSequence),
    success: true,
    totalTokens: 101,
    trial,
    usageFieldAudit: {
      cacheRead: "valid",
      cacheWrite: "valid",
      input: "valid",
      output: "valid",
      total: "valid",
    },
    variant,
    warmupPrerequisitePassed: phase === "warmup" ? null : true,
  };
}

function requestTimestamp(requestSequence, offsetMs = 0) {
  return new Date(
    Date.parse(TIMESTAMP) + requestSequence * REQUEST_SPACING_MS + offsetMs
  ).toISOString();
}

function refreshModel(model) {
  Object.assign(model, deriveModelViews(model.requests));
}

async function syntheticConfiguration() {
  const implementationSourcesSha256 = {};
  for (const sourcePath of REQUIRED_IMPLEMENTATION_SOURCE_PATHS) {
    implementationSourcesSha256[sourcePath] = sha256(
      await readFile(resolve(REPOSITORY_ROOT, sourcePath))
    );
  }
  const orderAssignments = [];
  for (const model of EXPECTED_MODELS) {
    for (let trial = 1; trial <= 8; trial += 1) {
      for (const scenario of SCENARIOS) {
        const pairOrder = pairOrderFor(
          model,
          scenario.name,
          EXPECTED_CAMPAIGN_ID,
          trial
        );
        orderAssignments.push({
          model,
          pairOrder,
          scenario: scenario.name,
          trial,
          variants:
            pairOrder === "control-first"
              ? [scenario.controlVariant, scenario.changedVariant]
              : [scenario.changedVariant, scenario.controlVariant],
        });
      }
    }
  }
  return {
    armExecutionOrder: {
      algorithm: MANUAL_METHODOLOGY.armExecutionAlgorithm,
      mode: "seeded-alternating-ab-ba",
      models: EXPECTED_MODELS,
      orderAssignments,
      phasesPerArm: ["warmup", "settle", "measure"],
      scenarios: SCENARIOS.map((scenario) => scenario.name),
      variantsByScenario: Object.fromEntries(
        SCENARIOS.map((scenario) => [
          scenario.name,
          [scenario.controlVariant, scenario.changedVariant],
        ])
      ),
    },
    armIsolation: MANUAL_METHODOLOGY.armIsolation,
    benchmarkSourceSha256: sha256(
      await readFile(
        resolve(REPOSITORY_ROOT, "scripts/benchmark-cache-stable-tools.mts")
      )
    ),
    campaignId: EXPECTED_CAMPAIGN_ID,
    comparisonSemantics: MANUAL_METHODOLOGY.comparisonSemantics,
    dynamicToolNames: [
      "query_issue_tracker",
      "query_release_notes",
      "query_session_memory",
      "query_dependency_docs",
    ],
    effectConclusionPolicy: MANUAL_METHODOLOGY.effectConclusionPolicy,
    eligibilitySemantics: MANUAL_METHODOLOGY.eligibilitySemantics,
    finishReasonValidation: {
      acceptedZeroToolReasons: ["stop"],
      policy: MANUAL_METHODOLOGY.finishReasonPolicy,
      statuses: [
        "accepted-stop",
        "invalid",
        "missing",
        "rejected-content-filter",
        "rejected-function-call",
        "rejected-length",
        "rejected-tool-calls",
      ],
    },
    fixedToolNames: [
      "runtime_status",
      "read_project_file",
      "list_project_files",
      "search_project_text",
    ],
    implementationSourcesSha256,
    maxOutputTokens: 256,
    membershipReplacementToolName: "query_archive_notes",
    minimumOrderStratumCoverage: 0.75,
    modelPreflight: {
      checkedAt: TIMESTAMP,
      presentModelIds: EXPECTED_MODELS,
      requestedModelIds: EXPECTED_MODELS,
      status: "passed",
    },
    models: EXPECTED_MODELS,
    nodeVersion: process.version,
    outputValidation: MANUAL_METHODOLOGY.outputValidation,
    pairedUncertainty: MANUAL_METHODOLOGY.pairedUncertainty,
    prefixLines: 700,
    requestTopology: {
      armsPerModel: 48,
      modelCount: 5,
      orderAssignmentCount: 120,
      pairOrderCount: 2,
      phasesPerArm: 2,
      requestsPerModel: 96,
      requestsPerScenario: {
        "same-set-order": 32,
        "active-set-change": 32,
        "membership-only-change": 32,
      },
      scenarioCount: 3,
      totalRequests: 480,
    },
    runId: RUN_ID,
    seed: EXPECTED_CAMPAIGN_ID,
    settleMs: 1500,
    sourceSnapshotSemantics: MANUAL_METHODOLOGY.sourceSnapshotSemantics,
    timeoutMs: 120_000,
    toolCallValidation: MANUAL_METHODOLOGY.toolCallValidation,
    toolChoice: "omitted-auto",
    trials: 8,
    usageValidation: MANUAL_METHODOLOGY.usageValidation,
  };
}

function trialsForOrder(model, scenario, pairOrder) {
  return Array.from({ length: 8 }, (_, index) => index + 1).filter(
    (trial) =>
      pairOrderFor(model, scenario, EXPECTED_CAMPAIGN_ID, trial) === pairOrder
  );
}

function staticImportSpecifiers(source) {
  return [...source.matchAll(STATIC_IMPORT_DECLARATION_PATTERN)].map(
    ([declaration]) => {
      const match =
        declaration.match(IMPORT_FROM_SPECIFIER_PATTERN) ??
        declaration.match(IMPORT_SIDE_EFFECT_SPECIFIER_PATTERN);
      assert.ok(match, `unrecognized static import: ${declaration}`);
      return match[1];
    }
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
