import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

const SOURCE_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));
const MAX_DATA_ARRAY_LENGTH = 10_000;
const EVIDENCE_DIRECTORY = fileURLToPath(
  new URL("../evidence/cache-telemetry/", import.meta.url)
);

export const independentConfirmationJsonPath = resolve(
  EVIDENCE_DIRECTORY,
  "2026-07-17-route-aware-confirmation.json"
);
export const independentConfirmationMarkdownPath = resolve(
  EVIDENCE_DIRECTORY,
  "2026-07-17-route-aware-confirmation.md"
);
const independentEvidenceIndexPath = resolve(EVIDENCE_DIRECTORY, "README.md");
const INDEX_SUMMARY_START = "<!-- route-aware-confirmation-index:start -->";
const INDEX_SUMMARY_END = "<!-- route-aware-confirmation-index:end -->";

export const STRICT_CORRECTNESS_VERIFICATION_LIMIT =
  "The independent verifier can recompute aggregates and guardrail decisions from the recorded strict-correctness booleans, but cannot independently re-grade strict correctness because model outputs are intentionally absent.";

const EXPECTED_ENDPOINT = "https://freerouter.minpeter.workers.dev/v1";
const SCENARIOS = ["conversation", "file-search"];
const ARMS = ["uniform", "route-aware"];
const RUN_ORDER = ["uniform", "route-aware", "route-aware", "uniform"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SAFE_SOURCE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const CREDENTIAL_LIKE_PATTERN =
  /Bearer\s+[A-Za-z0-9._-]{8,}|\b(?:fr|sk)-[A-Za-z0-9_-]{8,}\b/iu;
const FINISH_REASONS = new Set([
  "content-filter",
  "error",
  "length",
  "other",
  "stop",
  "tool-calls",
]);
const USAGE_STATUSES = new Set(["absent", "conflict", "invalid", "valid"]);
const FORBIDDEN_FIELDS = new Set(
  [
    "apiKey",
    "authorization",
    "expected",
    "expectedJson",
    "headers",
    "messages",
    "prompt",
    "requestBody",
    "responseBody",
    "responseText",
  ].map((key) => key.toLowerCase())
);
const BENCHMARK_SOURCE_PATHS = [
  "broad-context-cache-benchmark.mjs",
  "broad-context-cache-response.mjs",
  "freerouter-url.mjs",
];
const EVIDENCE_SOURCE_PATHS = [
  "assemble-cache-confirmation.mjs",
  "cache-confirmation-evidence.mjs",
  "cache-confirmation-independent-verifier.mjs",
  "verify-cache-evidence.mjs",
];
const CHECKED_IN_CONTENT = {
  modelOutputs: false,
  perTurnTelemetry: true,
  prompts: false,
  rawBodies: false,
};
const CORRECTNESS_DESIGN = {
  strict:
    "Trimmed response must parse as one JSON object with exactly the requested keys and exact values.",
  tokenRecallProxy:
    "Legacy expected-token containment is retained as a separate recall proxy and never substitutes for strict correctness.",
};
const GUARDRAIL_DESIGN = {
  exactResponseModelCoverage: 1,
  minTelemetryCoverage: 0.6,
  minTrackedWarmRequests: 6,
  requireEqualTrackedRequests: true,
  requireIdenticalTrackedCoordinates: true,
  requireKnownFinishReasons: true,
  requireNoCacheHitRegression: true,
  requireNoLengthFinishes: true,
  requireNoP95Regression: true,
  requireNoStrictCorrectnessRegression: true,
  requireNoTrackedUncachedTokenRegression: true,
  requirePerfectStrictCorrectness: true,
};
const CONFIRMATION_DESIGN = {
  arms: {
    "route-aware": {
      conversation: "75K high-water / 256 max output tokens",
      "file-search": "75K high-water / 160 max output tokens",
    },
    uniform: {
      conversation: "60K high-water / 512 max output tokens",
      "file-search": "60K high-water / 160 max output tokens",
    },
  },
  guardrails: GUARDRAIL_DESIGN,
  httpAttemptsPerTurn: 1,
  order: RUN_ORDER,
  replicatesPerArmPerScenario: 2,
  turnsPerRun: 6,
};
const ROUTES = {
  conversation: {
    arms: {
      "route-aware": { highWaterTokens: 75_000, maxOutputTokens: 256 },
      uniform: { highWaterTokens: 60_000, maxOutputTokens: 512 },
    },
    configMaxOutputTokens: 256,
    contextLength: 204_800,
    expectedTokenCount: 2,
    modelId: "minimaxai/minimax-m2.7",
  },
  "file-search": {
    arms: {
      "route-aware": { highWaterTokens: 75_000, maxOutputTokens: 160 },
      uniform: { highWaterTokens: 60_000, maxOutputTokens: 160 },
    },
    configMaxOutputTokens: 160,
    contextLength: 262_144,
    expectedTokenCount: 1,
    modelId: "mistralai/ministral-14b-latest",
  },
};
const EXPECTED_FIXTURES = {
  conversation: {
    chunks: [
      { characters: 60_063, expectedTokenCount: 2, step: 0 },
      { characters: 60_094, expectedTokenCount: 2, step: 1 },
      { characters: 60_064, expectedTokenCount: 2, step: 2 },
      { characters: 60_094, expectedTokenCount: 2, step: 3 },
      { characters: 60_063, expectedTokenCount: 2, step: 4 },
      { characters: 60_094, expectedTokenCount: 2, step: 5 },
    ],
    fixtureSha256:
      "18122b3d3b00aef1211079ff2cadd821b6b00acd65ad7a20ad19731a7c2d6295",
    highWaterTokens: 75_000,
    scenario: "conversation",
    schemaVersion: 1,
    steps: 6,
    targetChunkCharacters: 60_000,
  },
  "file-search": {
    chunks: [
      { characters: 64_839, expectedTokenCount: 1, step: 0 },
      { characters: 62_541, expectedTokenCount: 1, step: 1 },
      { characters: 63_038, expectedTokenCount: 1, step: 2 },
      { characters: 67_859, expectedTokenCount: 1, step: 3 },
      { characters: 67_038, expectedTokenCount: 1, step: 4 },
      { characters: 64_506, expectedTokenCount: 1, step: 5 },
    ],
    fixtureSha256:
      "1b90e71c309eb51e296aaf65d1d14d8be6b1dbc77c1ca35660168b1d846964c1",
    highWaterTokens: 75_000,
    scenario: "file-search",
    schemaVersion: 1,
    steps: 6,
    targetChunkCharacters: 60_000,
  },
};
const TOP_LEVEL_KEYS = [
  "assembledAt",
  "byScenario",
  "campaignCanonicalSha256",
  "campaigns",
  "checkedInContent",
  "confirmationConclusion",
  "confirmationDesign",
  "credentialRecorded",
  "deltas",
  "endpoint",
  "evidenceToolSource",
  "routeGuardrails",
  "schemaVersion",
  "summary",
];
const CAMPAIGN_KEYS = [
  "benchmarkSource",
  "campaignCompletedAt",
  "campaignStartedAt",
  "checkedInContent",
  "config",
  "credentialRecorded",
  "endpoint",
  "fixture",
  "modelCatalog",
  "runs",
  "scenario",
  "schemaVersion",
];
const RUN_KEYS = [
  "accuracyRate",
  "arm",
  "cacheAttributionEligibleWarmRequests",
  "cacheHitRate",
  "cacheIsolationKeySha256",
  "cacheWriteTelemetryCoverage",
  "compactionTriggers",
  "compactions",
  "failures",
  "highWaterTokens",
  "maxInputTokens",
  "maxOutputTokens",
  "medianLatencyMs",
  "missingFinishReasons",
  "modelId",
  "orderIndex",
  "p95LatencyMs",
  "policy",
  "replicate",
  "responseModelAudit",
  "telemetryCoverage",
  "tokenRecallRate",
  "trackedCacheReadTokens",
  "trackedCacheWriteTokens",
  "trackedInputTokens",
  "trackedRequests",
  "turns",
];
const TURN_KEYS = [
  "attempts",
  "cacheFieldReported",
  "cachedTokens",
  "cacheWriteFieldReported",
  "cacheWriteTokens",
  "correct",
  "errorClass",
  "finishReason",
  "httpStatus",
  "inputTokens",
  "latencyMs",
  "requestSuccessful",
  "responseModel",
  "responseModelMatchesRequested",
  "step",
  "tokenRecallCorrect",
  "usageEnvelopeValid",
  "usageFieldAudit",
];
const SUMMARY_KEYS = [
  "accuracyRate",
  "cacheAttributionEligibleWarmRequests",
  "cacheHitRate",
  "cacheWriteTelemetryCoverage",
  "correctResponses",
  "failures",
  "httpAttempts",
  "lengthFinishes",
  "logicalTurns",
  "maxInputTokens",
  "medianLatencyMs",
  "missingFinishReasons",
  "p95LatencyMs",
  "responseModelAudit",
  "successfulTurns",
  "telemetryCoverage",
  "tokenRecallCorrectResponses",
  "tokenRecallRate",
  "trackedCacheReadTokens",
  "trackedCacheWriteTokens",
  "trackedInputTokens",
  "trackedRequests",
  "trackedUncachedTokens",
  "trackedWarmCoordinates",
  "warmSuccessfulTurns",
];
const OBSERVATION_KEYS = [
  "accuracyRate",
  "cacheAttributionEligibleWarmRequests",
  "cacheHitRate",
  "exactResponseModelCoverage",
  "lengthFinishes",
  "logicalTurns",
  "missingFinishReasons",
  "p95LatencyMs",
  "successfulTurns",
  "telemetryCoverage",
  "trackedRequests",
  "trackedUncachedTokens",
  "trackedWarmCoordinates",
];

export function verifyCheckedInConfirmationEvidence(options = {}) {
  const jsonPath = options.jsonPath ?? independentConfirmationJsonPath;
  const markdownPath =
    options.markdownPath ?? independentConfirmationMarkdownPath;
  const indexPath = options.indexPath ?? independentEvidenceIndexPath;
  const jsonSource = readRegularArtifact(
    jsonPath,
    5_000_000,
    "confirmation JSON"
  );
  const markdown = readRegularArtifact(
    markdownPath,
    1_000_000,
    "confirmation Markdown"
  ).toString("utf8");
  const indexReadme = readRegularArtifact(
    indexPath,
    1_000_000,
    "confirmation evidence index"
  ).toString("utf8");
  let document;
  try {
    document = JSON.parse(jsonSource.toString("utf8"));
  } catch (error) {
    throw new Error("confirmation JSON is not valid JSON", { cause: error });
  }
  return verifyIndependentConfirmationArtifacts({
    document,
    indexReadme,
    markdown,
  });
}

export function verifyIndependentConfirmationArtifacts({
  document,
  indexReadme = null,
  markdown,
  verifyCurrentSources = true,
}) {
  const result = verifyIndependentConfirmationDocument(document, {
    verifyCurrentSources,
  });
  assert.equal(
    markdown,
    renderVerifiedMarkdown(document),
    "confirmation Markdown must equal the independently regenerated document"
  );
  if (indexReadme !== null) {
    assert.equal(
      typeof indexReadme,
      "string",
      "confirmation evidence index must be text"
    );
    verifyIndexSummary(indexReadme, document);
  }
  return {
    ...result,
    indexSummaryVerified: indexReadme !== null,
    markdownVerified: true,
  };
}

export function verifyIndependentConfirmationDocument(document, options = {}) {
  const verifyCurrentSources = options.verifyCurrentSources !== false;
  assertDataOnlyJsonTree(document, "confirmation document");
  assertPlainRecord(document, "confirmation document");
  exactKeys(document, TOP_LEVEL_KEYS, "confirmation document");
  assert.equal(document.schemaVersion, 1, "confirmation schemaVersion");
  assert.equal(document.endpoint, EXPECTED_ENDPOINT, "confirmation endpoint");
  assert.equal(
    document.credentialRecorded,
    false,
    "confirmation credentialRecorded"
  );
  assertIsoTimestamp(document.assembledAt, "confirmation assembledAt");
  assert.deepEqual(
    document.checkedInContent,
    CHECKED_IN_CONTENT,
    "confirmation checkedInContent"
  );
  assert.deepEqual(
    document.confirmationDesign,
    CONFIRMATION_DESIGN,
    "confirmation design"
  );
  assertSanitized(document, "confirmation document");

  const benchmarkSourceAtStart = verifyCurrentSources
    ? currentSourceManifest(BENCHMARK_SOURCE_PATHS)
    : null;
  const evidenceSourceAtStart = verifyCurrentSources
    ? currentSourceManifest(EVIDENCE_SOURCE_PATHS)
    : null;
  verifyManifest(document.evidenceToolSource, "evidenceToolSource");
  if (evidenceSourceAtStart !== null) {
    assert.deepEqual(
      document.evidenceToolSource,
      evidenceSourceAtStart,
      "evidenceToolSource must match current verifier and producer sources"
    );
  }

  assertPlainRecord(document.campaigns, "campaigns");
  assertPlainRecord(document.campaignCanonicalSha256, "campaign hashes");
  assertPlainRecord(document.byScenario, "byScenario");
  exactKeys(document.campaigns, SCENARIOS, "campaigns");
  exactKeys(document.campaignCanonicalSha256, SCENARIOS, "campaign hashes");
  exactKeys(document.byScenario, SCENARIOS, "byScenario");

  let latestCampaignCompletion = 0;
  for (const scenario of SCENARIOS) {
    const campaign = document.campaigns[scenario];
    verifyCampaign(campaign, scenario, benchmarkSourceAtStart);
    latestCampaignCompletion = Math.max(
      latestCampaignCompletion,
      Date.parse(campaign.campaignCompletedAt)
    );
  }
  assert.ok(
    Date.parse(document.assembledAt) >= latestCampaignCompletion,
    "confirmation assembledAt precedes a campaign completion"
  );

  const derived = deriveIndependentConfirmationFields(document);
  assert.deepEqual(
    document.campaignCanonicalSha256,
    derived.campaignCanonicalSha256,
    "campaign canonical hashes"
  );
  verifyScenarioSummaries(document.byScenario, "byScenario");
  assert.deepEqual(
    document.byScenario,
    derived.byScenario,
    "scenario summaries"
  );
  verifyArmSummaries(document.summary, "summary");
  assert.deepEqual(document.summary, derived.summary, "pooled arm summaries");
  verifyDeltas(document.deltas);
  assert.deepEqual(document.deltas, derived.deltas, "comparison deltas");
  verifyGuardrailShape(document.routeGuardrails);
  assert.deepEqual(
    document.routeGuardrails,
    derived.routeGuardrails,
    "route guardrail decisions"
  );
  verifyConclusionShape(document.confirmationConclusion);
  assert.deepEqual(
    document.confirmationConclusion,
    derived.confirmationConclusion,
    "confirmation conclusion"
  );

  if (verifyCurrentSources) {
    assert.deepEqual(
      currentSourceManifest(BENCHMARK_SOURCE_PATHS),
      benchmarkSourceAtStart,
      "benchmark sources changed during independent verification"
    );
    assert.deepEqual(
      currentSourceManifest(EVIDENCE_SOURCE_PATHS),
      evidenceSourceAtStart,
      "evidence sources changed during independent verification"
    );
  }

  return {
    campaignsVerified: SCENARIOS.length,
    logicalTurnsVerified: SCENARIOS.length * RUN_ORDER.length * 6,
    sourceManifestsVerified: verifyCurrentSources,
    strictCorrectnessVerification: {
      aggregateAndGuardrailRecomputedFromRecordedBooleans: true,
      independentlyRegradedFromModelOutputs: false,
      limitation: STRICT_CORRECTNESS_VERIFICATION_LIMIT,
      modelOutputsPresent: false,
    },
  };
}

export function deriveIndependentConfirmationFields(document) {
  assertDataOnlyJsonTree(document, "confirmation document");
  const campaigns = document.campaigns;
  const byScenario = Object.fromEntries(
    SCENARIOS.map((scenario) => [
      scenario,
      summarizeByArm(campaigns[scenario].runs),
    ])
  );
  const allRuns = SCENARIOS.flatMap((scenario) => campaigns[scenario].runs);
  const summary = summarizeByArm(allRuns);
  const routeGuardrails = deriveRouteGuardrails(byScenario);
  return {
    byScenario,
    campaignCanonicalSha256: Object.fromEntries(
      SCENARIOS.map((scenario) => [
        scenario,
        sha256(JSON.stringify(campaigns[scenario])),
      ])
    ),
    confirmationConclusion: deriveConclusion(routeGuardrails),
    deltas: deriveDeltas(summary),
    routeGuardrails,
    summary,
  };
}

export function recomputeIndependentRunFields(run) {
  assertDataOnlyJsonTree(run, "confirmation run");
  const aggregate = summarizeIndependentRuns([run]);
  return {
    accuracyRate: aggregate.accuracyRate,
    cacheAttributionEligibleWarmRequests:
      aggregate.cacheAttributionEligibleWarmRequests,
    cacheHitRate: aggregate.cacheHitRate,
    cacheWriteTelemetryCoverage: aggregate.cacheWriteTelemetryCoverage,
    failures: aggregate.failures,
    maxInputTokens: aggregate.maxInputTokens,
    medianLatencyMs: aggregate.medianLatencyMs,
    missingFinishReasons: aggregate.missingFinishReasons,
    p95LatencyMs: aggregate.p95LatencyMs,
    responseModelAudit: runResponseModelAudit(run.turns, run.modelId),
    telemetryCoverage: aggregate.telemetryCoverage,
    tokenRecallRate: aggregate.tokenRecallRate,
    trackedCacheReadTokens: aggregate.trackedCacheReadTokens,
    trackedCacheWriteTokens: aggregate.trackedCacheWriteTokens,
    trackedInputTokens: aggregate.trackedInputTokens,
    trackedRequests: aggregate.trackedRequests,
  };
}

export function summarizeIndependentRuns(runs) {
  assertDataOnlyJsonTree(runs, "confirmation runs");
  const turns = runs.flatMap((run) => run.turns);
  const successfulTurns = turns.filter((turn) => turn.requestSuccessful);
  const warmSuccessfulTurns = successfulTurns.filter((turn) => turn.step > 0);
  const attributableWarmTurns = warmSuccessfulTurns.filter(
    (turn) => turn.responseModelMatchesRequested === true
  );
  const readTrackedTurns = attributableWarmTurns.filter(isReadTracked);
  const writeTrackedTurns = attributableWarmTurns.filter(isWriteTracked);
  const trackedInputTokens = safeSum(
    readTrackedTurns.map((turn) => turn.inputTokens),
    "tracked input tokens"
  );
  const trackedCacheReadTokens = safeSum(
    readTrackedTurns.map((turn) => turn.cachedTokens),
    "tracked cache-read tokens"
  );
  const trackedCacheWriteTokens = safeSum(
    writeTrackedTurns.map((turn) => turn.cacheWriteTokens),
    "tracked cache-write tokens"
  );
  const latencies = successfulTurns.map((turn) => turn.latencyMs);
  const observedInputTokens = successfulTurns.flatMap((turn) =>
    turn.inputTokens === null ? [] : [turn.inputTokens]
  );
  return {
    accuracyRate: ratio(countTrue(turns, "correct"), turns.length),
    cacheAttributionEligibleWarmRequests: attributableWarmTurns.length,
    cacheHitRate:
      trackedInputTokens === 0
        ? null
        : trackedCacheReadTokens / trackedInputTokens,
    cacheWriteTelemetryCoverage: ratio(
      writeTrackedTurns.length,
      attributableWarmTurns.length
    ),
    correctResponses: countTrue(turns, "correct"),
    failures: turns.length - successfulTurns.length,
    httpAttempts: safeSum(
      turns.map((turn) => turn.attempts),
      "HTTP attempts"
    ),
    lengthFinishes: turns.filter((turn) => turn.finishReason === "length")
      .length,
    logicalTurns: turns.length,
    maxInputTokens:
      observedInputTokens.length === 0
        ? null
        : Math.max(...observedInputTokens),
    medianLatencyMs: nearestRank(latencies, 0.5),
    missingFinishReasons: successfulTurns.filter(
      (turn) => turn.finishReason === null
    ).length,
    p95LatencyMs: nearestRank(latencies, 0.95),
    responseModelAudit: aggregateResponseModelAudit(turns),
    successfulTurns: successfulTurns.length,
    telemetryCoverage: ratio(
      readTrackedTurns.length,
      attributableWarmTurns.length
    ),
    tokenRecallCorrectResponses: countTrue(turns, "tokenRecallCorrect"),
    tokenRecallRate: ratio(
      countTrue(turns, "tokenRecallCorrect"),
      turns.length
    ),
    trackedCacheReadTokens:
      readTrackedTurns.length === 0 ? null : trackedCacheReadTokens,
    trackedCacheWriteTokens:
      writeTrackedTurns.length === 0 ? null : trackedCacheWriteTokens,
    trackedInputTokens:
      readTrackedTurns.length === 0 ? null : trackedInputTokens,
    trackedRequests: readTrackedTurns.length,
    trackedUncachedTokens:
      readTrackedTurns.length === 0
        ? null
        : safeDifference(
            trackedInputTokens,
            trackedCacheReadTokens,
            "tracked uncached tokens"
          ),
    trackedWarmCoordinates: runs
      .flatMap((run) =>
        run.turns
          .filter(isReadTracked)
          .map((turn) => `${run.modelId}:${run.replicate}:${turn.step}`)
      )
      .sort(),
    warmSuccessfulTurns: warmSuccessfulTurns.length,
  };
}

export function renderIndependentConfirmationMarkdown(document, options = {}) {
  verifyIndependentConfirmationDocument(document, options);
  return renderVerifiedMarkdown(document);
}

export function renderIndependentConfirmationIndexBlock(
  document,
  options = {}
) {
  verifyIndependentConfirmationDocument(document, options);
  return renderVerifiedIndexBlock(document);
}

function verifyCampaign(campaign, scenario, currentBenchmarkSource) {
  const label = `campaigns.${scenario}`;
  const route = ROUTES[scenario];
  assertPlainRecord(campaign, label);
  exactKeys(campaign, CAMPAIGN_KEYS, label);
  assert.equal(campaign.schemaVersion, 2, `${label}.schemaVersion`);
  assert.equal(campaign.scenario, scenario, `${label}.scenario`);
  assert.equal(campaign.endpoint, EXPECTED_ENDPOINT, `${label}.endpoint`);
  assert.equal(
    campaign.credentialRecorded,
    false,
    `${label}.credentialRecorded`
  );
  assert.deepEqual(
    campaign.checkedInContent,
    CHECKED_IN_CONTENT,
    `${label}.checkedInContent`
  );
  assertIsoTimestamp(campaign.campaignStartedAt, `${label}.campaignStartedAt`);
  assertIsoTimestamp(
    campaign.campaignCompletedAt,
    `${label}.campaignCompletedAt`
  );
  assert.ok(
    Date.parse(campaign.campaignCompletedAt) >=
      Date.parse(campaign.campaignStartedAt),
    `${label} completed before it started`
  );
  verifyManifest(campaign.benchmarkSource, `${label}.benchmarkSource`);
  if (currentBenchmarkSource !== null) {
    assert.deepEqual(
      campaign.benchmarkSource,
      currentBenchmarkSource,
      `${label}.benchmarkSource must match current campaign sources`
    );
  }
  verifyCampaignConfig(campaign.config, route, label);
  verifyFixture(campaign.fixture, scenario, route, label);
  verifyModelCatalog(campaign.modelCatalog, route.modelId, campaign, label);
  assert.ok(Array.isArray(campaign.runs), `${label}.runs must be an array`);
  assert.equal(campaign.runs.length, RUN_ORDER.length, `${label}.runs.length`);
  const isolationKeys = new Set();
  for (const [index, run] of campaign.runs.entries()) {
    verifyRun(run, scenario, index);
    isolationKeys.add(run.cacheIsolationKeySha256);
  }
  assert.equal(
    isolationKeys.size,
    RUN_ORDER.length,
    `${label} cache-isolation hashes must be unique`
  );
}

function verifyCampaignConfig(config, route, label) {
  assertPlainRecord(config, `${label}.config`);
  exactKeys(
    config,
    [
      "confirmationMode",
      "confirmationOrder",
      "correctness",
      "highWaterTokens",
      "maximumHttpAttemptsPerTurn",
      "models",
      "steps",
      "targetChunkCharacters",
    ],
    `${label}.config`
  );
  assert.deepEqual(
    config.correctness,
    CORRECTNESS_DESIGN,
    `${label}.correctness`
  );
  assert.equal(config.confirmationMode, true, `${label}.confirmationMode`);
  assert.deepEqual(
    config.confirmationOrder,
    RUN_ORDER,
    `${label}.confirmationOrder`
  );
  assert.equal(config.highWaterTokens, 75_000, `${label}.highWaterTokens`);
  assert.equal(
    config.maximumHttpAttemptsPerTurn,
    1,
    `${label}.maximumHttpAttemptsPerTurn`
  );
  assert.equal(config.steps, 6, `${label}.steps`);
  assert.equal(
    config.targetChunkCharacters,
    60_000,
    `${label}.targetChunkCharacters`
  );
  assert.deepEqual(
    config.models,
    [
      {
        contextLength: route.contextLength,
        id: route.modelId,
        maxOutputTokens: route.configMaxOutputTokens,
      },
    ],
    `${label}.models`
  );
}

function verifyFixture(fixture, scenario, route, label) {
  assertPlainRecord(fixture, `${label}.fixture`);
  exactKeys(
    fixture,
    [
      "chunks",
      "fixtureSha256",
      "highWaterTokens",
      "scenario",
      "schemaVersion",
      "steps",
      "targetChunkCharacters",
    ],
    `${label}.fixture`
  );
  assert.equal(fixture.schemaVersion, 1, `${label}.fixture.schemaVersion`);
  assert.equal(fixture.scenario, scenario, `${label}.fixture.scenario`);
  assert.equal(fixture.steps, 6, `${label}.fixture.steps`);
  assert.equal(
    fixture.targetChunkCharacters,
    60_000,
    `${label}.fixture.targetChunkCharacters`
  );
  assert.equal(
    fixture.highWaterTokens,
    75_000,
    `${label}.fixture.highWaterTokens`
  );
  assert.match(fixture.fixtureSha256, SHA256_PATTERN, `${label}.fixture hash`);
  assert.ok(Array.isArray(fixture.chunks), `${label}.fixture.chunks`);
  assert.equal(fixture.chunks.length, 6, `${label}.fixture.chunks.length`);
  for (const [step, chunk] of fixture.chunks.entries()) {
    assertPlainRecord(chunk, `${label}.fixture.chunks[${step}]`);
    exactKeys(
      chunk,
      ["characters", "expectedTokenCount", "step"],
      `${label}.fixture.chunks[${step}]`
    );
    assert.equal(chunk.step, step, `${label}.fixture.chunks[${step}].step`);
    assertSafeNonNegativeInteger(
      chunk.characters,
      `${label}.fixture.chunks[${step}].characters`
    );
    assert.ok(
      chunk.characters >= 60_000 && chunk.characters <= 1_000_000,
      `${label}.fixture.chunks[${step}].characters is outside bounds`
    );
    assert.equal(
      chunk.expectedTokenCount,
      route.expectedTokenCount,
      `${label}.fixture.chunks[${step}].expectedTokenCount`
    );
  }
  assert.deepEqual(
    fixture,
    EXPECTED_FIXTURES[scenario],
    `${label}.fixture must match the independently pinned deterministic fixture`
  );
}

function verifyModelCatalog(catalog, modelId, campaign, label) {
  assertPlainRecord(catalog, `${label}.modelCatalog`);
  exactKeys(
    catalog,
    [
      "available",
      "checkedAt",
      "httpStatus",
      "presentModelIds",
      "requestedModelIds",
      "status",
    ],
    `${label}.modelCatalog`
  );
  assert.equal(catalog.available, true, `${label}.modelCatalog.available`);
  assertIsoTimestamp(catalog.checkedAt, `${label}.modelCatalog.checkedAt`);
  assert.ok(
    Date.parse(catalog.checkedAt) >= Date.parse(campaign.campaignStartedAt) &&
      Date.parse(catalog.checkedAt) <= Date.parse(campaign.campaignCompletedAt),
    `${label}.modelCatalog.checkedAt is outside the campaign window`
  );
  assert.equal(catalog.httpStatus, 200, `${label}.modelCatalog.httpStatus`);
  assert.deepEqual(
    catalog.requestedModelIds,
    [modelId],
    `${label}.requested models`
  );
  assert.deepEqual(
    catalog.presentModelIds,
    [modelId],
    `${label}.present models`
  );
  assert.equal(catalog.status, "passed", `${label}.modelCatalog.status`);
}

function verifyRun(run, scenario, index) {
  const label = `campaigns.${scenario}.runs[${index}]`;
  const route = ROUTES[scenario];
  const arm = RUN_ORDER[index];
  const expectedReplicate = index < 2 ? 1 : 2;
  assertPlainRecord(run, label);
  exactKeys(run, RUN_KEYS, label);
  assert.equal(run.arm, arm, `${label}.arm`);
  assert.equal(run.orderIndex, index, `${label}.orderIndex`);
  assert.equal(run.replicate, expectedReplicate, `${label}.replicate`);
  assert.equal(run.modelId, route.modelId, `${label}.modelId`);
  assert.equal(run.policy, "high-water-stable-prefix", `${label}.policy`);
  assert.match(
    run.cacheIsolationKeySha256,
    SHA256_PATTERN,
    `${label}.isolation hash`
  );
  assert.equal(
    run.highWaterTokens,
    route.arms[arm].highWaterTokens,
    `${label}.highWaterTokens`
  );
  assert.equal(
    run.maxOutputTokens,
    route.arms[arm].maxOutputTokens,
    `${label}.maxOutputTokens`
  );
  assert.ok(Array.isArray(run.turns), `${label}.turns must be an array`);
  assert.equal(run.turns.length, 6, `${label}.turns.length`);
  for (const [step, turn] of run.turns.entries()) {
    verifyTurn(turn, route.modelId, step, `${label}.turns[${step}]`);
  }
  assert.ok(
    Array.isArray(run.compactionTriggers),
    `${label}.compactionTriggers`
  );
  for (const [triggerIndex, trigger] of run.compactionTriggers.entries()) {
    assertSafeNonNegativeInteger(
      trigger,
      `${label}.compactionTriggers[${triggerIndex}]`
    );
  }
  assert.equal(
    run.compactions,
    run.compactionTriggers.length,
    `${label}.compactions`
  );
  verifyRunAuditShape(run.responseModelAudit, `${label}.responseModelAudit`);
  assert.deepEqual(
    run.responseModelAudit,
    runResponseModelAudit(run.turns, run.modelId),
    `${label}.responseModelAudit`
  );
  const expectedFields = recomputeIndependentRunFields(run);
  for (const [key, expected] of Object.entries(expectedFields)) {
    assert.deepEqual(run[key], expected, `${label}.${key}`);
  }
}

function verifyTurn(turn, requestedModel, step, label) {
  assertPlainRecord(turn, label);
  exactKeys(turn, TURN_KEYS, label);
  assert.equal(turn.step, step, `${label}.step`);
  assert.equal(turn.attempts, 1, `${label}.attempts`);
  for (const key of [
    "cacheFieldReported",
    "cacheWriteFieldReported",
    "correct",
    "requestSuccessful",
    "tokenRecallCorrect",
    "usageEnvelopeValid",
  ]) {
    assert.equal(
      typeof turn[key],
      "boolean",
      `${label}.${key} must be boolean`
    );
  }
  assertSafeTokenOrNull(turn.cachedTokens, `${label}.cachedTokens`);
  assertSafeTokenOrNull(turn.cacheWriteTokens, `${label}.cacheWriteTokens`);
  assertSafeTokenOrNull(turn.inputTokens, `${label}.inputTokens`);
  assertSafeNonNegativeInteger(turn.latencyMs, `${label}.latencyMs`);
  assert.ok(
    turn.httpStatus === null ||
      (Number.isSafeInteger(turn.httpStatus) &&
        turn.httpStatus >= 100 &&
        turn.httpStatus <= 599),
    `${label}.httpStatus`
  );
  assert.ok(
    turn.errorClass === null ||
      (typeof turn.errorClass === "string" &&
        SAFE_CODE_PATTERN.test(turn.errorClass)),
    `${label}.errorClass`
  );
  assert.ok(
    turn.finishReason === null || FINISH_REASONS.has(turn.finishReason),
    `${label}.finishReason`
  );
  assert.ok(
    turn.responseModel === null ||
      (typeof turn.responseModel === "string" &&
        SAFE_MODEL_ID_PATTERN.test(turn.responseModel)),
    `${label}.responseModel`
  );
  const expectedModelMatch =
    turn.responseModel === null ? null : turn.responseModel === requestedModel;
  assert.equal(
    turn.responseModelMatchesRequested,
    expectedModelMatch,
    `${label}.responseModelMatchesRequested`
  );
  if (turn.requestSuccessful) {
    assert.equal(turn.httpStatus, 200, `${label} successful HTTP status`);
    assert.equal(turn.errorClass, null, `${label} successful errorClass`);
    assert.equal(turn.finishReason, "stop", `${label} successful finishReason`);
  } else {
    assert.equal(turn.correct, false, `${label} failed strict correctness`);
    assert.equal(
      turn.tokenRecallCorrect,
      false,
      `${label} failed token recall`
    );
    assert.notEqual(turn.errorClass, null, `${label} failed errorClass`);
  }
  assertPlainRecord(turn.usageFieldAudit, `${label}.usageFieldAudit`);
  exactKeys(
    turn.usageFieldAudit,
    ["cacheRead", "cacheWrite", "input"],
    `${label}.usageFieldAudit`
  );
  for (const [field, status] of Object.entries(turn.usageFieldAudit)) {
    assert.ok(USAGE_STATUSES.has(status), `${label}.usageFieldAudit.${field}`);
  }
  verifyTelemetryField(
    turn.usageFieldAudit.cacheRead,
    turn.cachedTokens,
    turn.cacheFieldReported,
    `${label}.cacheRead`
  );
  verifyTelemetryField(
    turn.usageFieldAudit.cacheWrite,
    turn.cacheWriteTokens,
    turn.cacheWriteFieldReported,
    `${label}.cacheWrite`
  );
  verifyTelemetryField(
    turn.usageFieldAudit.input,
    turn.inputTokens,
    turn.inputTokens !== null,
    `${label}.input`
  );
  assert.equal(
    turn.usageEnvelopeValid,
    recomputeUsageEnvelopeValidity(turn),
    `${label}.usageEnvelopeValid`
  );
}

function verifyTelemetryField(status, value, reported, label) {
  if (status === "valid") {
    assert.notEqual(value, null, `${label} valid value`);
    assert.equal(reported, true, `${label} reported`);
    return;
  }
  assert.equal(value, null, `${label} rejected value`);
  assert.equal(reported, false, `${label} rejected report flag`);
}

function recomputeUsageEnvelopeValidity(turn) {
  if (turn.usageFieldAudit.input !== "valid" || turn.inputTokens === null) {
    return false;
  }
  if (
    !(
      isAbsentOrValid(turn.usageFieldAudit.cacheRead) &&
      isAbsentOrValid(turn.usageFieldAudit.cacheWrite)
    )
  ) {
    return false;
  }
  if (turn.cachedTokens !== null && turn.cachedTokens > turn.inputTokens) {
    return false;
  }
  if (
    turn.cacheWriteTokens !== null &&
    turn.cacheWriteTokens > turn.inputTokens
  ) {
    return false;
  }
  if (turn.cachedTokens !== null && turn.cacheWriteTokens !== null) {
    const combined = turn.cachedTokens + turn.cacheWriteTokens;
    if (!Number.isSafeInteger(combined) || combined > turn.inputTokens) {
      return false;
    }
  }
  return true;
}

function verifyRunAuditShape(audit, label) {
  assertPlainRecord(audit, label);
  exactKeys(
    audit,
    [
      "exactRequestedModel",
      "mismatched",
      "missingOrInvalid",
      "observedModels",
      "requestedModel",
      "turns",
    ],
    label
  );
  assertPlainRecord(audit.observedModels, `${label}.observedModels`);
  for (const [modelId, count] of Object.entries(audit.observedModels)) {
    assert.match(
      modelId,
      SAFE_MODEL_ID_PATTERN,
      `${label}.observedModels model`
    );
    assertSafeNonNegativeInteger(count, `${label}.observedModels.${modelId}`);
  }
}

function verifyScenarioSummaries(byScenario, label) {
  assertPlainRecord(byScenario, label);
  exactKeys(byScenario, SCENARIOS, label);
  for (const scenario of SCENARIOS) {
    verifyArmSummaries(byScenario[scenario], `${label}.${scenario}`);
  }
}

function verifyArmSummaries(summaries, label) {
  assertPlainRecord(summaries, label);
  exactKeys(summaries, ARMS, label);
  for (const arm of ARMS) {
    const summary = summaries[arm];
    assertPlainRecord(summary, `${label}.${arm}`);
    exactKeys(summary, SUMMARY_KEYS, `${label}.${arm}`);
    assert.ok(
      Array.isArray(summary.trackedWarmCoordinates),
      `${label}.${arm}.trackedWarmCoordinates`
    );
    const sortedCoordinates = [...summary.trackedWarmCoordinates].sort();
    assert.deepEqual(
      summary.trackedWarmCoordinates,
      sortedCoordinates,
      `${label}.${arm}.trackedWarmCoordinates must be sorted`
    );
    assert.equal(
      new Set(summary.trackedWarmCoordinates).size,
      summary.trackedWarmCoordinates.length,
      `${label}.${arm}.trackedWarmCoordinates must be unique`
    );
    assert.equal(
      summary.trackedWarmCoordinates.length,
      summary.trackedRequests,
      `${label}.${arm}.trackedWarmCoordinates count`
    );
    assertPlainRecord(
      summary.responseModelAudit,
      `${label}.${arm}.responseModelAudit`
    );
    exactKeys(
      summary.responseModelAudit,
      ["exactRequestedModel", "mismatched", "missingOrInvalid", "turns"],
      `${label}.${arm}.responseModelAudit`
    );
  }
}

function verifyDeltas(deltas) {
  assertPlainRecord(deltas, "deltas");
  exactKeys(
    deltas,
    ["accuracyRate", "cacheHitRate", "p95LatencyMs", "trackedUncachedTokens"],
    "deltas"
  );
}

function verifyGuardrailShape(routeGuardrails) {
  assertPlainRecord(routeGuardrails, "routeGuardrails");
  exactKeys(routeGuardrails, SCENARIOS, "routeGuardrails");
  for (const scenario of SCENARIOS) {
    const result = routeGuardrails[scenario];
    const label = `routeGuardrails.${scenario}`;
    assertPlainRecord(result, label);
    exactKeys(
      result,
      ["failedGuardrails", "indeterminateReasons", "observed", "status"],
      label
    );
    assert.ok(
      Array.isArray(result.failedGuardrails),
      `${label}.failedGuardrails`
    );
    assert.ok(
      Array.isArray(result.indeterminateReasons),
      `${label}.indeterminateReasons`
    );
    assert.ok(
      ["fail", "indeterminate", "pass"].includes(result.status),
      `${label}.status`
    );
    assertPlainRecord(result.observed, `${label}.observed`);
    exactKeys(result.observed, ["route-aware", "uniform"], `${label}.observed`);
    for (const arm of ["route-aware", "uniform"]) {
      const observation = result.observed[arm];
      assertPlainRecord(observation, `${label}.observed.${arm}`);
      exactKeys(observation, OBSERVATION_KEYS, `${label}.observed.${arm}`);
    }
  }
}

function verifyConclusionShape(conclusion) {
  assertPlainRecord(conclusion, "confirmationConclusion");
  exactKeys(conclusion, ["reason", "status"], "confirmationConclusion");
  assert.ok(
    ["fail", "indeterminate", "pass"].includes(conclusion.status),
    "confirmationConclusion.status"
  );
  assert.ok(
    typeof conclusion.reason === "string" && conclusion.reason.length <= 500,
    "confirmationConclusion.reason"
  );
}

function verifyManifest(manifest, label) {
  assertPlainRecord(manifest, label);
  exactKeys(manifest, ["files", "manifestSha256"], label);
  assert.ok(Array.isArray(manifest.files), `${label}.files must be an array`);
  assert.ok(manifest.files.length > 0, `${label}.files must not be empty`);
  const paths = new Set();
  for (const [index, file] of manifest.files.entries()) {
    const fileLabel = `${label}.files[${index}]`;
    assertPlainRecord(file, fileLabel);
    exactKeys(file, ["path", "sha256"], fileLabel);
    assert.ok(
      typeof file.path === "string" && SAFE_SOURCE_PATH_PATTERN.test(file.path),
      `${fileLabel}.path`
    );
    assert.match(file.sha256, SHA256_PATTERN, `${fileLabel}.sha256`);
    paths.add(file.path);
  }
  assert.equal(
    paths.size,
    manifest.files.length,
    `${label} contains duplicate paths`
  );
  assert.equal(
    manifest.manifestSha256,
    sha256(JSON.stringify(manifest.files)),
    `${label}.manifestSha256`
  );
}

function currentSourceManifest(paths) {
  const files = paths.map((path) => {
    const absolutePath = resolve(SOURCE_DIRECTORY, path);
    const stat = lstatSync(absolutePath);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink(),
      `${path} must be a regular source file`
    );
    return { path, sha256: sha256(readFileSync(absolutePath)) };
  });
  return { files, manifestSha256: sha256(JSON.stringify(files)) };
}

function summarizeByArm(runs) {
  return Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      summarizeIndependentRuns(runs.filter((run) => run.arm === arm)),
    ])
  );
}

function deriveDeltas(summary) {
  const uniform = summary.uniform;
  const routeAware = summary["route-aware"];
  return {
    accuracyRate: nullableDifference(
      routeAware.accuracyRate,
      uniform.accuracyRate
    ),
    cacheHitRate: nullableDifference(
      routeAware.cacheHitRate,
      uniform.cacheHitRate
    ),
    p95LatencyMs: nullableDifference(
      routeAware.p95LatencyMs,
      uniform.p95LatencyMs
    ),
    trackedUncachedTokens: nullableDifference(
      routeAware.trackedUncachedTokens,
      uniform.trackedUncachedTokens
    ),
  };
}

function deriveRouteGuardrails(byScenario) {
  return Object.fromEntries(
    SCENARIOS.map((scenario) => [
      scenario,
      deriveRouteResult(byScenario[scenario]),
    ])
  );
}

function deriveRouteResult(summaries) {
  const uniform = summaries.uniform;
  const routeAware = summaries["route-aware"];
  const observed = {
    "route-aware": guardrailObservation(routeAware),
    uniform: guardrailObservation(uniform),
  };
  const coordinatesMatch = arraysEqual(
    uniform.trackedWarmCoordinates,
    routeAware.trackedWarmCoordinates
  );
  const indeterminateReasons = deriveIndeterminateReasons(
    observed,
    uniform,
    routeAware,
    coordinatesMatch
  );
  const failedGuardrails = deriveFailedGuardrails(
    uniform,
    routeAware,
    coordinatesMatch
  );
  return {
    failedGuardrails,
    indeterminateReasons,
    observed,
    status: guardrailStatus(failedGuardrails, indeterminateReasons),
  };
}

function deriveIndeterminateReasons(
  observed,
  uniform,
  routeAware,
  coordinatesMatch
) {
  const indeterminateReasons = [];
  for (const [arm, value] of Object.entries(observed)) {
    if (value.logicalTurns !== 12 || value.successfulTurns !== 12) {
      indeterminateReasons.push(`${arm}:not-all-turns-succeeded`);
    }
    if (value.exactResponseModelCoverage !== 1) {
      indeterminateReasons.push(`${arm}:response-model-attribution-below-1`);
    }
    if (value.cacheAttributionEligibleWarmRequests !== 10) {
      indeterminateReasons.push(`${arm}:warm-attribution-incomplete`);
    }
    if (value.missingFinishReasons !== 0) {
      indeterminateReasons.push(`${arm}:finish-reason-incomplete`);
    }
    if (
      value.telemetryCoverage === null ||
      value.telemetryCoverage < 0.6 ||
      value.trackedRequests < 6
    ) {
      indeterminateReasons.push(`${arm}:cache-telemetry-below-minimum`);
    }
    if (
      value.cacheHitRate === null ||
      value.trackedUncachedTokens === null ||
      value.p95LatencyMs === null
    ) {
      indeterminateReasons.push(`${arm}:comparison-metric-unavailable`);
    }
  }
  if (uniform.trackedRequests !== routeAware.trackedRequests) {
    indeterminateReasons.push("arms:tracked-request-count-mismatch");
  }
  if (!coordinatesMatch) {
    indeterminateReasons.push("arms:tracked-coordinate-mismatch");
  }
  return indeterminateReasons;
}

function deriveFailedGuardrails(uniform, routeAware, coordinatesMatch) {
  const failedGuardrails = [];
  if (uniform.accuracyRate !== 1 || routeAware.accuracyRate !== 1) {
    failedGuardrails.push("perfect-strict-correctness");
  }
  if (routeAware.accuracyRate < uniform.accuracyRate) {
    failedGuardrails.push("strict-correctness-regression");
  }
  if (
    coordinatesMatch &&
    routeAware.cacheHitRate !== null &&
    uniform.cacheHitRate !== null &&
    routeAware.cacheHitRate < uniform.cacheHitRate
  ) {
    failedGuardrails.push("cache-hit-regression");
  }
  if (
    coordinatesMatch &&
    routeAware.trackedUncachedTokens !== null &&
    uniform.trackedUncachedTokens !== null &&
    routeAware.trackedUncachedTokens > uniform.trackedUncachedTokens
  ) {
    failedGuardrails.push("tracked-uncached-token-regression");
  }
  if (
    uniform.successfulTurns === uniform.logicalTurns &&
    routeAware.successfulTurns === routeAware.logicalTurns &&
    routeAware.p95LatencyMs !== null &&
    uniform.p95LatencyMs !== null &&
    routeAware.p95LatencyMs > uniform.p95LatencyMs
  ) {
    failedGuardrails.push("p95-latency-regression");
  }
  if (uniform.lengthFinishes !== 0 || routeAware.lengthFinishes !== 0) {
    failedGuardrails.push("length-finish-present");
  }
  return failedGuardrails;
}

function guardrailStatus(failedGuardrails, indeterminateReasons) {
  if (failedGuardrails.length > 0) {
    return "fail";
  }
  if (indeterminateReasons.length > 0) {
    return "indeterminate";
  }
  return "pass";
}

function deriveConclusion(routeGuardrails) {
  const entries = SCENARIOS.map((scenario) => [
    scenario,
    routeGuardrails[scenario],
  ]);
  if (entries.every(([, result]) => result.status === "pass")) {
    return {
      reason:
        "Both route exceptions passed every preregistered route-specific evidence and non-regression guardrail.",
      status: "pass",
    };
  }
  const failed = entries
    .filter(([, result]) => result.status === "fail")
    .map(([scenario]) => scenario);
  if (failed.length > 0) {
    return {
      reason: `At least one route had a directly observed correctness, completion, or comparable-metric guardrail failure: ${failed.join(", ")}.`,
      status: "fail",
    };
  }
  const indeterminate = entries
    .filter(([, result]) => result.status === "indeterminate")
    .map(([scenario]) => scenario);
  return {
    reason: `At least one route lacked the preregistered attribution, telemetry coverage, or completion metadata needed for a conclusion: ${indeterminate.join(", ")}.`,
    status: "indeterminate",
  };
}

function guardrailObservation(summary) {
  return {
    accuracyRate: summary.accuracyRate,
    cacheAttributionEligibleWarmRequests:
      summary.cacheAttributionEligibleWarmRequests,
    cacheHitRate: summary.cacheHitRate,
    exactResponseModelCoverage: ratio(
      summary.responseModelAudit.exactRequestedModel,
      summary.responseModelAudit.turns
    ),
    lengthFinishes: summary.lengthFinishes,
    logicalTurns: summary.logicalTurns,
    missingFinishReasons: summary.missingFinishReasons,
    p95LatencyMs: summary.p95LatencyMs,
    successfulTurns: summary.successfulTurns,
    telemetryCoverage: summary.telemetryCoverage,
    trackedRequests: summary.trackedRequests,
    trackedUncachedTokens: summary.trackedUncachedTokens,
    trackedWarmCoordinates: summary.trackedWarmCoordinates,
  };
}

function runResponseModelAudit(turns, requestedModel) {
  const observedModels = {};
  for (const turn of turns) {
    if (turn.responseModel !== null) {
      observedModels[turn.responseModel] =
        (observedModels[turn.responseModel] ?? 0) + 1;
    }
  }
  return {
    exactRequestedModel: turns.filter(
      (turn) => turn.responseModelMatchesRequested === true
    ).length,
    mismatched: turns.filter(
      (turn) => turn.responseModelMatchesRequested === false
    ).length,
    missingOrInvalid: turns.filter(
      (turn) => turn.responseModelMatchesRequested === null
    ).length,
    observedModels,
    requestedModel,
    turns: turns.length,
  };
}

function aggregateResponseModelAudit(turns) {
  return {
    exactRequestedModel: turns.filter(
      (turn) => turn.responseModelMatchesRequested === true
    ).length,
    mismatched: turns.filter(
      (turn) => turn.responseModelMatchesRequested === false
    ).length,
    missingOrInvalid: turns.filter(
      (turn) => turn.responseModelMatchesRequested === null
    ).length,
    turns: turns.length,
  };
}

function renderVerifiedMarkdown(document) {
  const uniform = document.summary.uniform;
  const routeAware = document.summary["route-aware"];
  const pooledRows = [
    markdownSummaryRow("Uniform 60K fallback", uniform),
    markdownSummaryRow("Route-aware exceptions", routeAware),
  ].join("\n");
  const routeRows = ["file-search", "conversation"]
    .map((scenario) =>
      markdownRouteRow(scenario, document.routeGuardrails[scenario])
    )
    .join("\n");
  const pooled = `Across both routes, the pooled descriptive totals measured ${percent(routeAware.cacheHitRate)} cache hit for route-aware versus ${percent(uniform.cacheHitRate)} for uniform, with strict correctness ${percent(routeAware.accuracyRate)} versus ${percent(uniform.accuracyRate)}. The pooled row is not used to accept either route.`;
  return `# Interleaved route-aware cache-policy confirmation

This checked-in snapshot combines two preregistered live campaigns run through
the OpenAI-compatible router on 2026-07-17. Each scenario used
\`uniform → route-aware → route-aware → uniform\`, two replicates per arm, six
turns per run, a fresh cache-isolation marker, and exactly one HTTP attempt per
logical turn.

**Overall preregistered result: ${document.confirmationConclusion.status}.**
${document.confirmationConclusion.reason}

${pooled}

## Per-route guardrails

| Route | Result | Strict correct, uniform → route-aware | Cache hit, uniform → route-aware | Read coverage | Tracked uncached tokens | p95 | Exact response-model attribution |
|---|---:|---:|---:|---:|---:|---:|---:|
${routeRows}

Each arm must complete 12/12 turns with perfect strict correctness and exact
response-model attribution, report valid read/input pairs for at least 6 of 10
attribution-eligible warm turns (60%), and track the identical replicate/step
coordinates in both arms. An observed correctness or completion failure remains
a failure even when another comparison metric is indeterminate.
Route-aware must not regress cache hit, tracked uncached tokens, p95, strict
correctness, or length finishes. A coverage or attribution miss is
\`indeterminate\`, not a pass.

## Pooled descriptive totals

| Arm | Strict correctness | Token recall | Warm cache hit | Read coverage | Write coverage | Exact response model | p50 | p95 | Successful turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${pooledRows}

The two exceptions under test were Ministral file search at a 75K projected
high-water (versus uniform 60K) and MiniMax conversation at 75K/256 output
(versus uniform 60K/512). The JSON snapshot retains sanitized per-turn status,
latency, strict-correctness and token-recall booleans, response-model audit,
and cache read/write/input telemetry. It contains no prompt, model output, raw
request or response body, authorization header, or credential.

The independent verifier can recompute aggregates and guardrail decisions from
the recorded strict-correctness booleans, but cannot independently re-grade
strict correctness because model outputs are intentionally absent.

This remains a small router-specific measurement. Cache hit rate is reported
only where the provider returned a valid read/input pair; cache-write coverage
and totals are separate because read hit alone does not establish billed cache
economics or savings. With only 12 turns per arm, the reported p95 is the sample
maximum, fixed ABBA ordering can only partially balance time drift, and no
interval or causal/generalized policy claim is made.
`;
}

function renderVerifiedIndexBlock(document) {
  const routeRows = ["file-search", "conversation"]
    .map((scenario) =>
      markdownRouteRow(scenario, document.routeGuardrails[scenario])
    )
    .join("\n");
  return `${INDEX_SUMMARY_START}
| Route | Result | Strict correct, uniform → route-aware | Cache hit, uniform → route-aware | Read coverage | Tracked uncached tokens | p95 | Exact response-model attribution |
|---|---:|---:|---:|---:|---:|---:|---:|
${routeRows}
${INDEX_SUMMARY_END}`;
}

function verifyIndexSummary(indexReadme, document) {
  const start = indexReadme.indexOf(INDEX_SUMMARY_START);
  const end = indexReadme.indexOf(INDEX_SUMMARY_END);
  assert.ok(start >= 0, "confirmation evidence index is missing start marker");
  assert.ok(end > start, "confirmation evidence index has invalid markers");
  assert.equal(
    indexReadme.indexOf(INDEX_SUMMARY_START, start + 1),
    -1,
    "confirmation evidence index has duplicate start markers"
  );
  assert.equal(
    indexReadme.indexOf(INDEX_SUMMARY_END, end + 1),
    -1,
    "confirmation evidence index has duplicate end markers"
  );
  assert.equal(
    indexReadme.slice(start, end + INDEX_SUMMARY_END.length),
    renderVerifiedIndexBlock(document),
    "confirmation evidence index summary must equal the independently regenerated block"
  );
}

function markdownSummaryRow(label, summary) {
  return `| ${label} | ${percent(summary.accuracyRate)} (${summary.correctResponses}/${summary.logicalTurns}) | ${percent(summary.tokenRecallRate)} | ${percent(summary.cacheHitRate)} | ${coverage(summary.trackedRequests, summary.cacheAttributionEligibleWarmRequests)} | ${percent(summary.cacheWriteTelemetryCoverage)} | ${summary.responseModelAudit.exactRequestedModel}/${summary.responseModelAudit.turns} | ${milliseconds(summary.medianLatencyMs)} | ${milliseconds(summary.p95LatencyMs)} | ${summary.successfulTurns}/${summary.logicalTurns} |`;
}

function markdownRouteRow(scenario, result) {
  const uniform = result.observed.uniform;
  const routeAware = result.observed["route-aware"];
  const label =
    scenario === "file-search"
      ? "Ministral file search"
      : "MiniMax conversation";
  return `| ${label} | ${result.status} | ${fraction(uniform.accuracyRate, uniform.logicalTurns)} → ${fraction(routeAware.accuracyRate, routeAware.logicalTurns)} | ${percent(uniform.cacheHitRate)} → ${percent(routeAware.cacheHitRate)} | ${coverage(uniform.trackedRequests, uniform.cacheAttributionEligibleWarmRequests)} → ${coverage(routeAware.trackedRequests, routeAware.cacheAttributionEligibleWarmRequests)} | ${numberOrNa(uniform.trackedUncachedTokens)} → ${numberOrNa(routeAware.trackedUncachedTokens)} | ${milliseconds(uniform.p95LatencyMs)} → ${milliseconds(routeAware.p95LatencyMs)} | ${percent(uniform.exactResponseModelCoverage)} → ${percent(routeAware.exactResponseModelCoverage)} |`;
}

function readRegularArtifact(path, maximumBytes, label) {
  const absolutePath = resolve(path);
  const stat = lstatSync(absolutePath);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    `${label} must be a regular file`
  );
  assert.ok(
    stat.size > 0 && stat.size <= maximumBytes,
    `${label} has an unsafe size`
  );
  return readFileSync(absolutePath);
}

function assertSanitized(value, label) {
  const stack = [[value, label]];
  while (stack.length > 0) {
    const [current, path] = stack.pop();
    if (typeof current === "string") {
      assert.doesNotMatch(
        current,
        CREDENTIAL_LIKE_PATTERN,
        `${path} contains a credential-like string`
      );
      continue;
    }
    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) {
        stack.push([item, `${path}[${index}]`]);
      }
      continue;
    }
    if (current === null || typeof current !== "object") {
      continue;
    }
    assertPlainRecord(current, path);
    for (const [key, nested] of Object.entries(current)) {
      assert.ok(
        !FORBIDDEN_FIELDS.has(key.toLowerCase()),
        `${path} contains forbidden field ${key}`
      );
      stack.push([nested, `${path}.${key}`]);
    }
  }
}

function assertDataOnlyJsonTree(value, label) {
  const activeAncestors = new Set();
  const stack = [[value, label]];
  while (stack.length > 0) {
    const [current, path, leaving = false] = stack.pop();
    if (leaving) {
      activeAncestors.delete(current);
      continue;
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      assert.ok(
        Number.isFinite(current),
        `${path} must be a finite JSON number`
      );
      continue;
    }
    assert.equal(typeof current, "object", `${path} must be JSON data`);
    assert.equal(
      utilTypes.isProxy(current),
      false,
      `${path} must not be a Proxy`
    );
    assert.ok(
      !activeAncestors.has(current),
      `${path} must not contain a cycle`
    );
    activeAncestors.add(current);
    stack.push([current, path, true]);

    let array;
    let prototype;
    let keys;
    try {
      array = Array.isArray(current);
      prototype = Object.getPrototypeOf(current);
      keys = Reflect.ownKeys(current);
    } catch (error) {
      throw new TypeError(`${path} cannot be inspected as JSON data`, {
        cause: error,
      });
    }

    if (array) {
      queueDenseArrayValues(current, path, prototype, keys, stack);
      continue;
    }
    queuePlainRecordValues(current, path, prototype, keys, stack);
  }
}

function queueDenseArrayValues(value, path, prototype, keys, stack) {
  assert.equal(prototype, Array.prototype, `${path} must be a plain array`);
  const lengthDescriptor = safeOwnDescriptor(value, "length", path);
  assert.ok(
    lengthDescriptor && Object.hasOwn(lengthDescriptor, "value"),
    `${path}.length must be an own data property`
  );
  const length = lengthDescriptor.value;
  assertSafeNonNegativeInteger(length, `${path}.length`);
  assert.ok(
    length <= MAX_DATA_ARRAY_LENGTH,
    `${path}.length must be at most ${MAX_DATA_ARRAY_LENGTH}`
  );
  assert.deepEqual(
    keys,
    [...Array.from({ length }, (_, index) => String(index)), "length"],
    `${path} must be dense and contain no extra properties`
  );
  for (let index = 0; index < length; index += 1) {
    const descriptor = safeOwnDescriptor(value, String(index), path);
    assert.ok(
      descriptor && Object.hasOwn(descriptor, "value"),
      `${path}[${index}] must be an own data property`
    );
    stack.push([descriptor.value, `${path}[${index}]`]);
  }
}

function queuePlainRecordValues(value, path, prototype, keys, stack) {
  assert.ok(
    prototype === Object.prototype || prototype === null,
    `${path} must be a plain object`
  );
  for (const key of keys) {
    assert.equal(typeof key, "string", `${path} must not contain symbol keys`);
    const descriptor = safeOwnDescriptor(value, key, path);
    assert.ok(
      descriptor && Object.hasOwn(descriptor, "value"),
      `${path}.${key} must be an own data property`
    );
    assert.equal(
      descriptor.enumerable,
      true,
      `${path}.${key} must be enumerable JSON data`
    );
    stack.push([descriptor.value, `${path}.${key}`]);
  }
}

function safeOwnDescriptor(value, key, label) {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch (error) {
    throw new TypeError(`${label}.${String(key)} cannot be inspected`, {
      cause: error,
    });
  }
}

function assertPlainRecord(value, label) {
  assert.ok(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a plain object`
  );
}

function exactKeys(value, expectedKeys, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expectedKeys].sort(),
    `${label} keys`
  );
}

function assertIsoTimestamp(value, label) {
  assert.ok(
    typeof value === "string" &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    `${label} must be an ISO timestamp`
  );
}

function assertSafeNonNegativeInteger(value, label) {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer`
  );
}

function assertSafeTokenOrNull(value, label) {
  if (value !== null) {
    assertSafeNonNegativeInteger(value, label);
  }
}

function safeSum(values, label) {
  let result = 0;
  for (const value of values) {
    assertSafeNonNegativeInteger(value, label);
    result += value;
    assert.ok(
      Number.isSafeInteger(result),
      `${label} exceeds the safe integer range`
    );
  }
  return result;
}

function safeDifference(left, right, label) {
  const result = left - right;
  assert.ok(Number.isSafeInteger(result) && result >= 0, `${label} is invalid`);
  return result;
}

function nearestRank(values, quantile) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  ];
}

function isReadTracked(turn) {
  return (
    turn.step > 0 &&
    turn.requestSuccessful &&
    turn.responseModelMatchesRequested === true &&
    turn.cachedTokens !== null &&
    turn.inputTokens !== null &&
    turn.usageEnvelopeValid
  );
}

function isWriteTracked(turn) {
  return (
    turn.step > 0 &&
    turn.requestSuccessful &&
    turn.responseModelMatchesRequested === true &&
    turn.cacheWriteTokens !== null &&
    turn.usageEnvelopeValid
  );
}

function isAbsentOrValid(status) {
  return status === "absent" || status === "valid";
}

function countTrue(values, key) {
  return values.filter((value) => value[key] === true).length;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function nullableDifference(left, right) {
  return left === null || right === null ? null : left - right;
}

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fraction(rate, total) {
  return rate === null ? "n/a" : `${Math.round(rate * total)}/${total}`;
}

function numberOrNa(value) {
  return value === null ? "n/a" : value.toLocaleString("en-US");
}

function coverage(tracked, denominator) {
  return denominator === 0 ? "n/a" : `${tracked}/${denominator}`;
}

function percent(value) {
  return value === null || value === undefined
    ? "n/a"
    : `${(value * 100).toFixed(2)}%`;
}

function milliseconds(value) {
  return value === null ? "n/a" : `${(value / 1000).toFixed(3)} s`;
}
