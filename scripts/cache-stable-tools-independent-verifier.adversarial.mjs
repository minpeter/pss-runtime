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
const IMPORT_PATTERN = /\bfrom\s+["']([^"']+)["']/gu;
const PRODUCER_IMPORT_PATTERN =
  /(?:from|import\s*\()\s*["'][^"']*benchmark-cache-stable-tools\.mts/u;

let pristine;

test("independent verifier has no producer-module dependency", async () => {
  const source = await readFile(
    resolve(
      REPOSITORY_ROOT,
      "scripts/cache-stable-tools-independent-verifier.mjs"
    ),
    "utf8"
  );
  const imports = [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  assert.ok(imports.every((specifier) => specifier.startsWith("node:")));
  assert.doesNotMatch(source, PRODUCER_IMPORT_PATTERN);
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
    evidence,
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
    generatedAt: TIMESTAMP,
    interpretation: {
      "not-reported": "No recognized cache-read field was reported.",
      "reported-nonzero":
        "At least one positive cache-read value was reported.",
      "reported-zero-only": "Only zero cache-read values were reported.",
      unavailable: "No measured request was eligible.",
    },
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
    completedAt: TIMESTAMP,
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
    startedAt: TIMESTAMP,
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
      algorithm: "Independent synthetic alternating-order fixture.",
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
    armIsolation: {
      canary: "Unique canary per arm.",
      promptNamespace: "Unique namespace per arm.",
    },
    benchmarkSourceSha256: sha256(
      await readFile(
        resolve(REPOSITORY_ROOT, "scripts/benchmark-cache-stable-tools.mts")
      )
    ),
    campaignId: EXPECTED_CAMPAIGN_ID,
    comparisonSemantics: Object.fromEntries(
      SCENARIOS.map((scenario) => [scenario.name, "Synthetic comparison."])
    ),
    dynamicToolNames: [
      "query_issue_tracker",
      "query_release_notes",
      "query_session_memory",
      "query_dependency_docs",
    ],
    effectConclusionPolicy: "Order-stratified directional conclusions.",
    eligibilitySemantics: {
      cacheTelemetryEligible: "Validated envelope and exact model.",
      captureSuccess: "Exact OK response without tool calls.",
    },
    finishReasonValidation: {
      acceptedZeroToolReasons: ["stop"],
      policy: "Only stop is accepted.",
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
    outputValidation: "Only exact trimmed OK is accepted.",
    pairedUncertainty: "Descriptive AB and BA summaries.",
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
    timeoutMs: 120_000,
    toolCallValidation: "Modern and legacy calls fail closed.",
    toolChoice: "omitted-auto",
    trials: 8,
    usageValidation: "Safe nonnegative token envelope.",
  };
}

function trialsForOrder(model, scenario, pairOrder) {
  return Array.from({ length: 8 }, (_, index) => index + 1).filter(
    (trial) =>
      pairOrderFor(model, scenario, EXPECTED_CAMPAIGN_ID, trial) === pairOrder
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
