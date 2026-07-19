import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  independentConfirmationJsonPath as confirmationJsonPath,
  independentConfirmationMarkdownPath as confirmationMarkdownPath,
  verifyCheckedInConfirmationEvidence,
} from "./cache-confirmation-independent-verifier.mjs";

const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SAFE_ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._-]{8,}/i;
const BROAD_TOP_KEYS = [
  "campaignDate",
  "checkedInContent",
  "comparableAggregate",
  "credentialRecorded",
  "endpoint",
  "httpAttemptBreakdown",
  "httpAttemptCount",
  "logicalTurnCount",
  "methodology",
  "models",
  "routeIncident",
  "runtimeCommit",
  "scenarios",
  "schemaVersion",
  "sourceArtifacts",
];
const TUNING_TOP_KEYS = [
  "benchmarkSource",
  "campaignDate",
  "checkedInContent",
  "combinedEvidenceFootprint",
  "credentialRecorded",
  "endpoint",
  "fullCoverageProviderControls",
  "httpAttemptBreakdown",
  "httpAttemptCount",
  "logicalTurnCount",
  "methodology",
  "miniMaxOutputSweep",
  "parentEvidence",
  "parentEvidenceCampaignSha256",
  "parentEvidenceSha256",
  "referenceAggregates",
  "runtimeCommit",
  "schemaVersion",
  "sourceArtifacts",
  "tunedCandidates",
  "variantAggregates",
  "variants",
];
const LEGACY_RUN_KEYS = [
  "accuracyRate",
  "cacheHitRate",
  "compactionTriggers",
  "compactions",
  "failures",
  "maxInputTokens",
  "medianLatencyMs",
  "modelId",
  "p95LatencyMs",
  "policy",
  "scenario",
  "successfulTurns",
  "telemetryCoverage",
  "trackedCacheReadTokens",
  "trackedInputTokens",
  "trackedRequests",
  "turns",
];
const LEGACY_TURN_KEYS = [
  "attempts",
  "cacheFieldReported",
  "cachedTokens",
  "correct",
  "errorClass",
  "finishReason",
  "httpStatus",
  "inputTokens",
  "latencyMs",
  "step",
];

const evidenceRoot = new URL("../evidence/cache-telemetry/", import.meta.url);
const broadUrl = new URL("2026-07-17-broad-context.json", evidenceRoot);
const tuningUrl = new URL("2026-07-17-policy-tuning.json", evidenceRoot);
const broadSource = readFileSync(broadUrl);
const broad = JSON.parse(broadSource);
const tuning = JSON.parse(readFileSync(tuningUrl, "utf8"));

exactKeys(broad, BROAD_TOP_KEYS, "broad-context top level");
exactKeys(tuning, TUNING_TOP_KEYS, "policy-tuning top level");
verifySanitizedSnapshot("broad-context", broad);
verifySanitizedSnapshot("policy-tuning", tuning);
validateHistoricalSourceArtifactMetadata(
  broad.sourceArtifacts,
  "broad-context"
);
validateHistoricalSourceArtifactMetadata(
  tuning.sourceArtifacts,
  "policy-tuning"
);
verifyLegacyBenchmarkSource(tuning.benchmarkSource);
assert.match(
  tuning.parentEvidenceCampaignSha256,
  SHA256_PATTERN,
  "policy-tuning historical parentEvidenceCampaignSha256"
);
assert.equal(
  createHash("sha256").update(broadSource).digest("hex"),
  tuning.parentEvidenceSha256,
  "policy-tuning parentEvidenceSha256"
);

const broadRuns = broad.scenarios.flatMap((scenario) =>
  scenario.runs.map((run) => ({ ...run, scenario: scenario.scenario }))
);
for (const run of broadRuns) {
  verifyRun(run, `broad/${run.modelId}/${run.policy}`);
}
const broadTurns = broadRuns.flatMap((run) => run.turns);
verifyHeadlineCounts(broad, broadTurns, "broad-context");
verifyRouteIncident(broad.routeIncident, broadRuns);

const comparableModelIds = new Set([
  "minimaxai/minimax-m2.7",
  "mistralai/ministral-14b-latest",
  "zai-org/glm-4.7",
]);
for (const policy of [
  "legacy-rewrite-every-step",
  "high-water-stable-prefix",
]) {
  const runs = broadRuns.filter(
    (run) => comparableModelIds.has(run.modelId) && run.policy === policy
  );
  const actual = aggregateRuns(runs);
  const recorded = broad.comparableAggregate[policy];
  verifyFields(
    recorded,
    {
      accuracyRate: actual.accuracyRate,
      cacheHitRate: actual.cacheHitRate,
      compactions: actual.compactions,
      correctResponses: actual.correctTurns,
      logicalTurns: actual.logicalTurns,
      medianLatencyMs: actual.medianLatencyMs,
      medianMaximumInputTokens: actual.medianRunMaximumInputTokens,
      p95LatencyMs: actual.p95LatencyMs,
      successfulTurns: actual.successfulTurns,
      telemetryCoverage: actual.telemetryCoverage,
    },
    `broad comparable ${policy}`
  );
}
const referencePolicies = {
  rewriteEveryStep: "legacy-rewrite-every-step",
  stable75k: "high-water-stable-prefix",
};
exactKeys(
  tuning.referenceAggregates,
  Object.keys(referencePolicies),
  "referenceAggregates"
);
for (const [name, policy] of Object.entries(referencePolicies)) {
  const actual = publishedAggregate(
    aggregateRuns(
      broadRuns.filter(
        (run) => comparableModelIds.has(run.modelId) && run.policy === policy
      )
    )
  );
  exactKeys(
    tuning.referenceAggregates[name],
    Object.keys(actual),
    `${name} reference`
  );
  verifyFields(tuning.referenceAggregates[name], actual, `${name} reference`);
}

for (const variant of tuning.variants) {
  for (const run of variant.runs) {
    verifyRun(run, `${variant.id}/${run.modelId}/${run.scenario}`);
  }
  const actual = aggregateRuns(variant.runs);
  verifyFields(variant.aggregate, actual, `${variant.id} aggregate`);
  verifyFields(
    tuning.variantAggregates[variant.id],
    actual,
    `${variant.id} duplicate aggregate`
  );
}

const allTuningRuns = tuning.variants.flatMap((variant) => variant.runs);
const allTuningTurns = allTuningRuns.flatMap((run) => run.turns);
assert.equal(
  allTuningTurns.length,
  tuning.logicalTurnCount,
  "logicalTurnCount"
);
assert.equal(
  sum(allTuningTurns.map((turn) => turn.attempts)),
  tuning.httpAttemptCount,
  "httpAttemptCount"
);
assert.equal(
  allTuningTurns.filter((turn) => turn.attempts === 1).length,
  tuning.httpAttemptBreakdown.oneAttemptTurns,
  "one-attempt count"
);
assert.equal(
  allTuningTurns.filter((turn) => turn.attempts === 2).length,
  tuning.httpAttemptBreakdown.twoAttemptTurns,
  "two-attempt count"
);
verifyHeadlineCounts(tuning, allTuningTurns, "policy-tuning");
assert.deepEqual(
  tuning.combinedEvidenceFootprint,
  {
    followUpHttpAttempts: tuning.httpAttemptCount,
    followUpLogicalTurns: tuning.logicalTurnCount,
    parentHttpAttempts: broad.httpAttemptCount,
    parentLogicalTurns: broad.logicalTurnCount,
    totalHttpAttempts: broad.httpAttemptCount + tuning.httpAttemptCount,
    totalLogicalTurns: broad.logicalTurnCount + tuning.logicalTurnCount,
  },
  "combinedEvidenceFootprint"
);

const stable45 = composeUniformCandidate(45_000, 512);
const stable60 = composeUniformCandidate(60_000, 512);
verifyFields(
  tuning.tunedCandidates.stable45kWithMiniMax512.aggregate,
  aggregateRuns(stable45),
  "45K MiniMax-512 candidate"
);
verifyCandidate(
  tuning.tunedCandidates.stable60kWithMiniMax512,
  stable60,
  "60K MiniMax-512 candidate"
);

const routeAwareRuns = tuning.tunedCandidates.routeAwareHybrid.policyMatrix.map(
  (entry) => routeRun(entry)
);
verifyCandidate(
  tuning.tunedCandidates.routeAwareHybrid,
  routeAwareRuns,
  "route-aware candidate"
);

verifyFields(
  tuning.miniMaxOutputSweep.output256,
  aggregateRuns(
    modelRuns(variant("stable-60k-default-output"), "minimaxai/minimax-m2.7")
  ),
  "MiniMax 256 sweep"
);
verifyFields(
  tuning.miniMaxOutputSweep.output384,
  aggregateRuns(variant("minimax-60k-output-384").runs),
  "MiniMax 384 sweep"
);
verifyFields(
  tuning.miniMaxOutputSweep.output512,
  aggregateRuns(variant("minimax-60k-output-512").runs),
  "MiniMax 512 sweep"
);
verifyFields(
  tuning.miniMaxOutputSweep.output512DeepResearchReplicate,
  aggregateRuns(variant("minimax-60k-output-512-research-replicate").runs),
  "MiniMax 512 replicate"
);

verifyFullCoverageControl(
  "stable45k",
  variant("stable-45k-default-output").runs.filter(isFullCoverageModel)
);
verifyFullCoverageControl(
  "stable60k",
  variant("stable-60k-default-output").runs.filter(isFullCoverageModel)
);
verifyFullCoverageControl(
  "stable75kReference",
  broadRuns.filter(
    (run) =>
      isFullCoverageModel(run) && run.policy === "high-water-stable-prefix"
  )
);

let confirmationCampaignsVerified = 0;
if (existsSync(confirmationJsonPath)) {
  assert.ok(
    existsSync(confirmationMarkdownPath),
    "confirmation markdown is required with confirmation JSON"
  );
  const confirmationVerification = verifyCheckedInConfirmationEvidence();
  confirmationCampaignsVerified = confirmationVerification.campaignsVerified;
  assert.equal(confirmationCampaignsVerified, 2, "confirmation campaign count");
  assert.equal(
    confirmationVerification.logicalTurnsVerified,
    48,
    "confirmation logical turn count"
  );
} else {
  assert.equal(
    process.env.PSS_ALLOW_MISSING_CACHE_CONFIRMATION,
    "true",
    "confirmation evidence is required; use PSS_ALLOW_MISSING_CACHE_CONFIRMATION=true only during the pre-live implementation phase"
  );
}

console.log(
  JSON.stringify({
    broadContextRunsVerified: broadRuns.length,
    confirmationCampaignsVerified,
    historicalSourceArtifactMetadataValidated: true,
    parentEvidenceSha256Verified: true,
    policyTuningRunsVerified: allTuningRuns.length,
    sanitizedSnapshotsVerified: true,
  })
);

function composeUniformCandidate(highWaterTokens, miniMaxOutputTokens) {
  const base = variant(`stable-${highWaterTokens / 1000}k-default-output`);
  const miniMax = variant(
    `minimax-${highWaterTokens / 1000}k-output-${miniMaxOutputTokens}`
  );
  return [
    ...base.runs.filter((run) => run.modelId !== "minimaxai/minimax-m2.7"),
    ...miniMax.runs,
  ];
}

function routeRun(entry) {
  if (entry.highWaterTokens === 75_000) {
    const run = broadRuns.find(
      (candidate) =>
        candidate.modelId === entry.modelId &&
        candidate.policy === "high-water-stable-prefix" &&
        candidate.scenario === entry.scenario
    );
    assert.ok(run, `missing 75K route ${entry.scenario}/${entry.modelId}`);
    return run;
  }

  const source =
    entry.modelId === "minimaxai/minimax-m2.7" && entry.maxOutputTokens === 512
      ? variant("minimax-60k-output-512")
      : variant("stable-60k-default-output");
  const run = source.runs.find(
    (candidate) =>
      candidate.modelId === entry.modelId &&
      candidate.scenario === entry.scenario
  );
  assert.ok(run, `missing 60K route ${entry.scenario}/${entry.modelId}`);
  return run;
}

function verifyCandidate(candidate, runs, label) {
  verifyFields(candidate.aggregate, aggregateRuns(runs), `${label} aggregate`);
  for (const [scenario, recorded] of Object.entries(candidate.byScenario)) {
    verifyFields(
      recorded,
      aggregateRuns(runs.filter((run) => run.scenario === scenario)),
      `${label}/${scenario}`
    );
  }
}

function publishedAggregate(actual) {
  return {
    accuracyRate: actual.accuracyRate,
    cacheHitRate: actual.cacheHitRate,
    compactions: actual.compactions,
    correctResponses: actual.correctTurns,
    lengthFinishes: actual.lengthFinishes,
    logicalTurns: actual.logicalTurns,
    medianLatencyMs: actual.medianLatencyMs,
    medianMaximumInputTokens: actual.medianRunMaximumInputTokens,
    p95LatencyMs: actual.p95LatencyMs,
    successfulTurns: actual.successfulTurns,
    telemetryCoverage: actual.telemetryCoverage,
  };
}

function verifyFullCoverageControl(name, runs) {
  const warm = runs
    .flatMap((run) => run.turns)
    .filter((turn) => turn.httpStatus === 200 && turn.step > 0);
  assert.ok(
    warm.every(
      (turn) =>
        turn.cacheFieldReported &&
        typeof turn.cachedTokens === "number" &&
        typeof turn.inputTokens === "number"
    ),
    `${name} must have full warm telemetry coverage`
  );
  verifyFields(
    tuning.fullCoverageProviderControls[name].aggregate,
    aggregateRuns(runs),
    `${name} full-coverage control`
  );
}

function isFullCoverageModel(run) {
  return (
    run.modelId === "mistralai/ministral-14b-latest" ||
    run.modelId === "zai-org/glm-4.7"
  );
}

function variant(id) {
  const found = tuning.variants.find((entry) => entry.id === id);
  assert.ok(found, `missing variant ${id}`);
  return found;
}

function modelRuns(entry, modelId) {
  return entry.runs.filter((run) => run.modelId === modelId);
}

function verifyRun(run, label) {
  verifyLegacyRunShape(run, label);
  const actual = aggregateRuns([run]);
  verifyFields(
    run,
    {
      accuracyRate: actual.accuracyRate,
      cacheHitRate: actual.cacheHitRate,
      compactions: actual.compactions,
      failures: actual.logicalTurns - actual.successfulTurns,
      maxInputTokens: actual.maximumInputTokens,
      medianLatencyMs: actual.medianLatencyMs,
      p95LatencyMs: actual.p95LatencyMs,
      successfulTurns: actual.successfulTurns,
      telemetryCoverage: actual.telemetryCoverage,
      trackedCacheReadTokens: actual.trackedCacheReadTokens,
      trackedInputTokens: actual.trackedInputTokens,
      trackedRequests: actual.trackedRequests,
    },
    label
  );
  assert.equal(
    run.compactionTriggers.length,
    run.compactions,
    `${label}.compactions`
  );
}

function verifyHeadlineCounts(report, turns, label) {
  assertSafeCount(report.logicalTurnCount, `${label}.logicalTurnCount`);
  assertSafeCount(report.httpAttemptCount, `${label}.httpAttemptCount`);
  assert.equal(
    turns.length,
    report.logicalTurnCount,
    `${label}.logicalTurnCount`
  );
  assert.equal(
    sum(turns.map((turn) => turn.attempts)),
    report.httpAttemptCount,
    `${label}.httpAttemptCount`
  );
  assertPlainObject(
    report.httpAttemptBreakdown,
    `${label}.httpAttemptBreakdown`
  );
  exactKeys(
    report.httpAttemptBreakdown,
    ["oneAttemptTurns", "twoAttemptTurns"],
    `${label}.httpAttemptBreakdown`
  );
  assert.deepEqual(
    report.httpAttemptBreakdown,
    {
      oneAttemptTurns: turns.filter((turn) => turn.attempts === 1).length,
      twoAttemptTurns: turns.filter((turn) => turn.attempts === 2).length,
    },
    `${label}.httpAttemptBreakdown`
  );
}

function verifyRouteIncident(incident, runs) {
  assertPlainObject(incident, "routeIncident");
  exactKeys(
    incident,
    [
      "httpAttempts",
      "interpretation",
      "legacySuccessfulTurns",
      "logicalTurnsPerPolicy",
      "modelId",
      "observedErrorClass",
      "stablePrefixSuccessfulTurns",
    ],
    "routeIncident"
  );
  assert.match(
    incident.modelId,
    SAFE_MODEL_ID_PATTERN,
    "routeIncident.modelId"
  );
  const routeRuns = runs.filter((run) => run.modelId === incident.modelId);
  assert.ok(routeRuns.length > 0, "routeIncident model must have runs");
  const byPolicy = Object.fromEntries(
    ["legacy-rewrite-every-step", "high-water-stable-prefix"].map((policy) => [
      policy,
      routeRuns.filter((run) => run.policy === policy),
    ])
  );
  const legacyTurns = byPolicy["legacy-rewrite-every-step"].flatMap(
    (run) => run.turns
  );
  const stableTurns = byPolicy["high-water-stable-prefix"].flatMap(
    (run) => run.turns
  );
  assert.equal(
    legacyTurns.length,
    incident.logicalTurnsPerPolicy,
    "routeIncident.logicalTurnsPerPolicy legacy"
  );
  assert.equal(
    stableTurns.length,
    incident.logicalTurnsPerPolicy,
    "routeIncident.logicalTurnsPerPolicy stable"
  );
  assert.equal(
    legacyTurns.filter((turn) => turn.httpStatus === 200).length,
    incident.legacySuccessfulTurns,
    "routeIncident.legacySuccessfulTurns"
  );
  assert.equal(
    stableTurns.filter((turn) => turn.httpStatus === 200).length,
    incident.stablePrefixSuccessfulTurns,
    "routeIncident.stablePrefixSuccessfulTurns"
  );
  const routeTurns = [...legacyTurns, ...stableTurns];
  assert.equal(
    sum(routeTurns.map((turn) => turn.attempts)),
    incident.httpAttempts,
    "routeIncident.httpAttempts"
  );
  const errorClasses = [
    ...new Set(
      routeTurns.flatMap((turn) =>
        turn.errorClass === null ? [] : [turn.errorClass]
      )
    ),
  ];
  assert.deepEqual(
    errorClasses,
    [incident.observedErrorClass],
    "routeIncident.observedErrorClass"
  );
  assert.equal(
    incident.interpretation,
    "Treat as route availability evidence, not a model-quality or context-window comparison.",
    "routeIncident.interpretation"
  );
}

function aggregateRuns(runs) {
  const turns = runs.flatMap((run) => run.turns);
  const successful = turns.filter((turn) => turn.httpStatus === 200);
  const warm = successful.filter((turn) => turn.step > 0);
  const tracked = warm.filter(
    (turn) =>
      turn.cacheFieldReported &&
      typeof turn.cachedTokens === "number" &&
      typeof turn.inputTokens === "number" &&
      turn.cachedTokens <= turn.inputTokens
  );
  const inputTokens = sum(tracked.map((turn) => turn.inputTokens));
  const cacheReadTokens = sum(tracked.map((turn) => turn.cachedTokens));
  const latencies = successful.map((turn) => turn.latencyMs);
  const runMaximums = runs.map((run) =>
    Math.max(
      0,
      ...run.turns
        .filter((turn) => turn.httpStatus === 200)
        .map((turn) => turn.inputTokens ?? 0)
    )
  );
  return {
    accuracyRate: divide(
      turns.filter((turn) => turn.correct).length,
      turns.length
    ),
    cacheHitRate: inputTokens === 0 ? undefined : cacheReadTokens / inputTokens,
    compactions: sum(runs.map((run) => run.compactions)),
    correctTurns: turns.filter((turn) => turn.correct).length,
    httpAttempts: sum(turns.map((turn) => turn.attempts)),
    lengthFinishes: turns.filter((turn) => turn.finishReason === "length")
      .length,
    logicalTurns: turns.length,
    maximumInputTokens: Math.max(0, ...runMaximums),
    meanLatencyMs: divide(sum(latencies), latencies.length),
    medianLatencyMs: percentile(latencies, 0.5),
    medianRunMaximumInputTokens: percentile(runMaximums, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    successfulTurns: successful.length,
    telemetryCoverage: divide(tracked.length, warm.length),
    trackedCacheReadTokens: cacheReadTokens,
    trackedInputTokens: inputTokens,
    trackedRequests: tracked.length,
    trackedUncachedTokens: inputTokens - cacheReadTokens,
  };
}

function verifySanitizedSnapshot(label, report) {
  assert.equal(report.schemaVersion, 1, `${label}.schemaVersion`);
  assert.equal(report.credentialRecorded, false, `${label}.credentialRecorded`);
  assert.deepEqual(
    report.checkedInContent,
    {
      modelOutputs: false,
      perTurnTelemetry: true,
      prompts: false,
      rawBodies: false,
    },
    `${label}.checkedInContent`
  );
  walk(report, (key, value) => {
    assert.ok(
      ![
        "apiKey",
        "authorization",
        "expected",
        "headers",
        "messages",
        "prompt",
        "requestBody",
        "responseBody",
        "responseText",
      ].includes(key),
      `${label} contains forbidden field ${key}`
    );
    if (typeof value === "string") {
      assert.doesNotMatch(value, BEARER_TOKEN_PATTERN, `${label} bearer token`);
    }
  });
}

function validateHistoricalSourceArtifactMetadata(artifacts, label) {
  assert.ok(Array.isArray(artifacts), `${label}.sourceArtifacts`);
  assert.ok(artifacts.length > 0, `${label}.sourceArtifacts must not be empty`);
  const names = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    const artifactLabel = `${label}.sourceArtifacts[${index}]`;
    assertPlainObject(artifact, artifactLabel);
    const allowedKeys = new Set(["completedAt", "name", "sha256", "variant"]);
    assert.ok(
      Object.keys(artifact).every((key) => allowedKeys.has(key)),
      `${artifactLabel} keys`
    );
    assert.match(
      artifact.name,
      SAFE_ARTIFACT_NAME_PATTERN,
      `${artifactLabel}.name`
    );
    assert.match(artifact.sha256, SHA256_PATTERN, `${artifactLabel}.sha256`);
    assert.ok(!names.has(artifact.name), `${artifactLabel}.name duplicate`);
    names.add(artifact.name);
    if (Object.hasOwn(artifact, "completedAt")) {
      assert.ok(
        typeof artifact.completedAt === "string" &&
          Number.isFinite(Date.parse(artifact.completedAt)),
        `${artifactLabel}.completedAt`
      );
    }
    if (Object.hasOwn(artifact, "variant")) {
      assert.match(
        artifact.variant,
        SAFE_ARTIFACT_NAME_PATTERN,
        `${artifactLabel}.variant`
      );
    }
  }
}

function verifyLegacyBenchmarkSource(source) {
  assertPlainObject(source, "policy-tuning.benchmarkSource");
  exactKeys(
    source,
    ["baseName", "baseSha256", "streamedTransformations"],
    "policy-tuning.benchmarkSource"
  );
  assert.match(
    source.baseName,
    SAFE_ARTIFACT_NAME_PATTERN,
    "policy-tuning.benchmarkSource.baseName"
  );
  assert.match(
    source.baseSha256,
    SHA256_PATTERN,
    "policy-tuning.benchmarkSource.baseSha256"
  );
  assert.ok(
    Array.isArray(source.streamedTransformations) &&
      source.streamedTransformations.every(
        (value) => typeof value === "string" && value.length <= 200
      ),
    "policy-tuning.benchmarkSource.streamedTransformations"
  );
}

function verifyLegacyRunShape(run, label) {
  assertPlainObject(run, label);
  exactKeys(run, LEGACY_RUN_KEYS, label);
  assert.match(run.modelId, SAFE_MODEL_ID_PATTERN, `${label}.modelId`);
  assert.ok(
    ["legacy-rewrite-every-step", "high-water-stable-prefix"].includes(
      run.policy
    ),
    `${label}.policy`
  );
  assert.ok(
    ["conversation", "deep-research", "file-search"].includes(run.scenario),
    `${label}.scenario`
  );
  assertRateOrNull(run.accuracyRate, `${label}.accuracyRate`, false);
  assertRateOrNull(run.cacheHitRate, `${label}.cacheHitRate`, true);
  assertRateOrNull(run.telemetryCoverage, `${label}.telemetryCoverage`, true);
  for (const key of [
    "compactions",
    "failures",
    "maxInputTokens",
    "successfulTurns",
    "trackedCacheReadTokens",
    "trackedInputTokens",
    "trackedRequests",
  ]) {
    assertSafeCount(run[key], `${label}.${key}`);
  }
  assertSafeCountOrNull(run.medianLatencyMs, `${label}.medianLatencyMs`);
  assertSafeCountOrNull(run.p95LatencyMs, `${label}.p95LatencyMs`);
  assert.ok(
    Array.isArray(run.compactionTriggers),
    `${label}.compactionTriggers`
  );
  for (const [index, value] of run.compactionTriggers.entries()) {
    assertSafeCount(value, `${label}.compactionTriggers[${index}]`);
  }
  assert.ok(Array.isArray(run.turns), `${label}.turns`);
  assert.equal(run.turns.length, 6, `${label}.turns.length`);
  for (const [index, turn] of run.turns.entries()) {
    assertPlainObject(turn, `${label}.turns[${index}]`);
    exactKeys(turn, LEGACY_TURN_KEYS, `${label}.turns[${index}]`);
    assert.equal(turn.step, index, `${label}.turns[${index}].step`);
    assert.ok(
      Number.isSafeInteger(turn.attempts) &&
        turn.attempts >= 1 &&
        turn.attempts <= 2,
      `${label}.turns[${index}].attempts`
    );
    assert.equal(
      typeof turn.cacheFieldReported,
      "boolean",
      `${label}.turns[${index}].cacheFieldReported`
    );
    assert.equal(
      typeof turn.correct,
      "boolean",
      `${label}.turns[${index}].correct`
    );
    assertSafeCount(turn.latencyMs, `${label}.turns[${index}].latencyMs`);
    assert.ok(
      turn.httpStatus === null || turn.httpStatus === 200,
      `${label}.turns[${index}].httpStatus`
    );
    assert.ok(
      turn.finishReason === null ||
        turn.finishReason === "length" ||
        turn.finishReason === "stop",
      `${label}.turns[${index}].finishReason`
    );
    assert.ok(
      turn.errorClass === null ||
        (typeof turn.errorClass === "string" &&
          SAFE_CODE_PATTERN.test(turn.errorClass)),
      `${label}.turns[${index}].errorClass`
    );
    assertSafeCountOrNull(
      turn.cachedTokens,
      `${label}.turns[${index}].cachedTokens`
    );
    assertSafeCountOrNull(
      turn.inputTokens,
      `${label}.turns[${index}].inputTokens`
    );
    assert.equal(
      turn.cacheFieldReported,
      turn.cachedTokens !== null,
      `${label}.turns[${index}] cache-field presence`
    );
    if (turn.cachedTokens !== null) {
      assert.notEqual(
        turn.inputTokens,
        null,
        `${label}.turns[${index}] cache/input pair`
      );
      assert.ok(
        turn.cachedTokens <= turn.inputTokens,
        `${label}.turns[${index}] cache read exceeds input`
      );
    }
  }
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  if (!(value && typeof value === "object")) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    visit(key, nested);
    walk(nested, visit);
  }
}

function verifyFields(recorded, actual, label) {
  for (const [key, expected] of Object.entries(actual)) {
    assert.ok(key in recorded, `${label}.${key}: missing expected field`);
    const observed = recorded[key];
    if (expected === undefined && observed === null) {
      continue;
    }
    if (typeof expected === "number" && typeof observed === "number") {
      const tolerance = Math.max(1, Math.abs(expected)) * 1e-12;
      assert.ok(
        Math.abs(observed - expected) <= tolerance,
        `${label}.${key}: expected ${expected}, recorded ${observed}`
      );
    } else {
      assert.deepEqual(observed, expected, `${label}.${key}`);
    }
  }
}

function percentile(values, quantile) {
  if (values.length === 0) {
    return;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  ];
}

function divide(numerator, denominator) {
  return denominator === 0 ? undefined : numerator / denominator;
}

function sum(values) {
  let total = 0;
  for (const value of values) {
    assertSafeCount(value, "aggregate value");
    total += value;
    assert.ok(
      Number.isSafeInteger(total),
      "aggregate exceeded safe integer range"
    );
  }
  return total;
}

function exactKeys(value, keys, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} keys`
  );
}

function assertPlainObject(value, label) {
  assert.ok(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a plain object`
  );
}

function assertSafeCount(value, label) {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer`
  );
}

function assertSafeCountOrNull(value, label) {
  if (value !== null) {
    assertSafeCount(value, label);
  }
}

function assertRateOrNull(value, label, allowNull) {
  if (value === null && allowNull) {
    return;
  }
  assert.ok(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    `${label} must be between zero and one${allowNull ? " or null" : ""}`
  );
}
