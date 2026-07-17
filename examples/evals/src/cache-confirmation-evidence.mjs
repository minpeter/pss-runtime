import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runnerUrl = new URL(
  "./broad-context-cache-benchmark.mjs",
  import.meta.url
);
const runnerPath = fileURLToPath(runnerUrl);
const benchmarkSourceEntries = [
  ["broad-context-cache-benchmark.mjs", runnerUrl],
  [
    "broad-context-cache-response.mjs",
    new URL("./broad-context-cache-response.mjs", import.meta.url),
  ],
  ["freerouter-url.mjs", new URL("./freerouter-url.mjs", import.meta.url)],
];
const evidenceToolSourceEntries = [
  [
    "assemble-cache-confirmation.mjs",
    new URL("./assemble-cache-confirmation.mjs", import.meta.url),
  ],
  ["cache-confirmation-evidence.mjs", new URL(import.meta.url)],
  [
    "cache-confirmation-independent-verifier.mjs",
    new URL("./cache-confirmation-independent-verifier.mjs", import.meta.url),
  ],
  [
    "verify-cache-evidence.mjs",
    new URL("./verify-cache-evidence.mjs", import.meta.url),
  ],
];
const evidenceRoot = resolve(
  fileURLToPath(new URL("../evidence/cache-telemetry/", import.meta.url))
);

export const confirmationJsonPath = resolve(
  evidenceRoot,
  "2026-07-17-route-aware-confirmation.json"
);
export const confirmationMarkdownPath = resolve(
  evidenceRoot,
  "2026-07-17-route-aware-confirmation.md"
);

const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SAFE_MANIFEST_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const CREDENTIAL_LIKE_PATTERN =
  /Bearer\s+[A-Za-z0-9._-]{8,}|\b(?:fr|sk)-[A-Za-z0-9_-]{8,}\b/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXPECTED_ENDPOINT = "https://freerouter.minpeter.workers.dev/v1";
const FINISH_REASONS = new Set([
  "content-filter",
  "error",
  "length",
  "other",
  "stop",
  "tool-calls",
]);
const USAGE_AUDIT_STATUSES = new Set([
  "absent",
  "conflict",
  "invalid",
  "valid",
]);
const CONFIRMATION_ORDER = ["uniform", "route-aware", "route-aware", "uniform"];
const CONFIRMATION_GUARDRAILS = {
  exactResponseModelCoverage: 1,
  minTelemetryCoverage: 0.6,
  minTrackedWarmRequests: 6,
  requireIdenticalTrackedCoordinates: true,
  requireEqualTrackedRequests: true,
  requireKnownFinishReasons: true,
  requireNoCacheHitRegression: true,
  requireNoLengthFinishes: true,
  requireNoP95Regression: true,
  requireNoStrictCorrectnessRegression: true,
  requireNoTrackedUncachedTokenRegression: true,
  requirePerfectStrictCorrectness: true,
};
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

export function readCampaignFile(path) {
  const absolutePath = resolve(path);
  const stat = lstatSync(absolutePath);
  assert.ok(stat.isFile(), `${absolutePath} must be a regular file`);
  assert.ok(!stat.isSymbolicLink(), `${absolutePath} must not be a symlink`);
  assert.ok(
    stat.size > 0 && stat.size <= 5_000_000,
    `${absolutePath} has an unsafe size`
  );
  const source = readFileSync(absolutePath);
  let report;
  try {
    report = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`${absolutePath} is not valid JSON`, { cause: error });
  }
  return { absolutePath, report, source };
}

export function verifyConfirmationCampaign(report, options = {}) {
  const label = options.label ?? "confirmation campaign";
  assertPlainObject(report, label);
  exactKeys(
    report,
    [
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
    ],
    label
  );
  assert.equal(report.schemaVersion, 2, `${label}.schemaVersion`);
  assert.equal(report.credentialRecorded, false, `${label}.credentialRecorded`);
  assert.equal(report.endpoint, EXPECTED_ENDPOINT, `${label}.endpoint`);
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
  assertNoForbiddenContent(report, label);
  assertIsoTimestamp(report.campaignStartedAt, `${label}.campaignStartedAt`);
  assertIsoTimestamp(
    report.campaignCompletedAt,
    `${label}.campaignCompletedAt`
  );
  assert.ok(
    Date.parse(report.campaignCompletedAt) >=
      Date.parse(report.campaignStartedAt),
    `${label} completed before it started`
  );
  verifySourceManifest(report.benchmarkSource, `${label}.benchmarkSource`);

  const route = expectedRoute(report.scenario);
  verifyConfig(report.config, route, label);
  verifyFixtureManifest(report.fixture, route, label);
  verifyModelCatalog(report.modelCatalog, route.modelId, label);

  assert.ok(Array.isArray(report.runs), `${label}.runs must be an array`);
  assert.equal(report.runs.length, 4, `${label}.runs.length`);
  const isolationKeys = new Set();
  for (const [index, run] of report.runs.entries()) {
    const arm = CONFIRMATION_ORDER[index];
    verifyConfirmationRun(run, {
      arm,
      index,
      label: `${label}.runs[${index}]`,
      route,
    });
    isolationKeys.add(run.cacheIsolationKeySha256);
  }
  assert.equal(
    isolationKeys.size,
    4,
    `${label} cache isolation keys must be unique`
  );

  if (options.verifyCurrentProvenance !== false) {
    assert.deepEqual(
      report.benchmarkSource,
      sourceManifest(benchmarkSourceEntries),
      `${label}.benchmarkSource does not match the current behavior sources`
    );
    const currentFixture = currentFixtureManifest(report.scenario);
    assert.deepEqual(
      report.fixture,
      currentFixture,
      `${label}.fixture does not match the current fixture-only output`
    );
  }

  return {
    campaign: report,
    route,
    summary: aggregateConfirmationRuns(report.runs),
  };
}

export function buildCombinedConfirmation(campaignEntries) {
  assert.equal(campaignEntries.length, 2, "exactly two campaigns are required");
  const verified = campaignEntries.map(({ report }, index) =>
    verifyConfirmationCampaign(report, {
      label: `campaign[${index}]`,
      verifyCurrentProvenance: true,
    })
  );
  const byScenario = Object.fromEntries(
    verified.map(({ campaign }) => [
      campaign.scenario,
      armSummaries(campaign.runs),
    ])
  );
  assert.deepEqual(
    Object.keys(byScenario).sort(),
    ["conversation", "file-search"],
    "confirmation scenarios"
  );
  const campaigns = Object.fromEntries(
    verified.map(({ campaign }) => [campaign.scenario, campaign])
  );
  const allRuns = verified.flatMap(({ campaign }) => campaign.runs);
  const summary = armSummaries(allRuns);
  const routeGuardrails = evaluateRouteGuardrails(byScenario);
  const confirmationConclusion =
    evaluateConfirmationConclusion(routeGuardrails);
  const assembledAt = new Date().toISOString();
  const combined = {
    assembledAt,
    byScenario,
    campaignCanonicalSha256: Object.fromEntries(
      Object.entries(campaigns).map(([scenario, campaign]) => [
        scenario,
        canonicalJsonSha256(campaign),
      ])
    ),
    campaigns,
    checkedInContent: {
      modelOutputs: false,
      perTurnTelemetry: true,
      prompts: false,
      rawBodies: false,
    },
    confirmationDesign: {
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
      httpAttemptsPerTurn: 1,
      guardrails: CONFIRMATION_GUARDRAILS,
      order: CONFIRMATION_ORDER,
      replicatesPerArmPerScenario: 2,
      turnsPerRun: 6,
    },
    credentialRecorded: false,
    deltas: comparisonDeltas(summary),
    endpoint: EXPECTED_ENDPOINT,
    evidenceToolSource: sourceManifest(evidenceToolSourceEntries),
    confirmationConclusion,
    routeGuardrails,
    schemaVersion: 1,
    summary,
  };
  assertNoForbiddenContent(combined, "combined confirmation");
  return combined;
}

export function verifyCombinedConfirmation(combined) {
  assertPlainObject(combined, "combined confirmation");
  exactKeys(
    combined,
    [
      "assembledAt",
      "byScenario",
      "campaignCanonicalSha256",
      "campaigns",
      "checkedInContent",
      "confirmationDesign",
      "confirmationConclusion",
      "credentialRecorded",
      "deltas",
      "endpoint",
      "evidenceToolSource",
      "schemaVersion",
      "summary",
      "routeGuardrails",
    ],
    "combined confirmation"
  );
  assert.equal(
    combined.schemaVersion,
    1,
    "combined confirmation.schemaVersion"
  );
  assert.equal(
    combined.credentialRecorded,
    false,
    "combined confirmation.credentialRecorded"
  );
  assert.equal(
    combined.endpoint,
    EXPECTED_ENDPOINT,
    "combined confirmation.endpoint"
  );
  assertIsoTimestamp(combined.assembledAt, "combined confirmation.assembledAt");
  assertNoForbiddenContent(combined, "combined confirmation");
  verifySourceManifest(
    combined.evidenceToolSource,
    "combined confirmation.evidenceToolSource"
  );
  assert.deepEqual(
    combined.evidenceToolSource,
    sourceManifest(evidenceToolSourceEntries),
    "combined confirmation.evidenceToolSource"
  );
  assert.deepEqual(
    combined.checkedInContent,
    {
      modelOutputs: false,
      perTurnTelemetry: true,
      prompts: false,
      rawBodies: false,
    },
    "combined confirmation.checkedInContent"
  );
  assert.deepEqual(
    combined.confirmationDesign,
    {
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
      httpAttemptsPerTurn: 1,
      guardrails: CONFIRMATION_GUARDRAILS,
      order: CONFIRMATION_ORDER,
      replicatesPerArmPerScenario: 2,
      turnsPerRun: 6,
    },
    "combined confirmation.confirmationDesign"
  );
  assertPlainObject(combined.campaigns, "combined confirmation.campaigns");
  assertPlainObject(
    combined.campaignCanonicalSha256,
    "combined confirmation.campaignCanonicalSha256"
  );
  assertPlainObject(combined.byScenario, "combined confirmation.byScenario");
  for (const [value, label] of [
    [combined.campaignCanonicalSha256, "campaignCanonicalSha256"],
    [combined.byScenario, "byScenario"],
  ]) {
    exactKeys(
      value,
      ["conversation", "file-search"],
      `combined confirmation.${label}`
    );
  }

  const entries = Object.entries(combined.campaigns);
  assert.deepEqual(
    entries.map(([scenario]) => scenario).sort(),
    ["conversation", "file-search"],
    "combined confirmation.campaigns"
  );
  for (const [scenario, campaign] of entries) {
    assert.equal(campaign.scenario, scenario, `${scenario} campaign key`);
    verifyConfirmationCampaign(campaign, {
      label: `combined.${scenario}`,
      verifyCurrentProvenance: true,
    });
    assert.equal(
      combined.campaignCanonicalSha256[scenario],
      canonicalJsonSha256(campaign),
      `${scenario} canonical campaign hash`
    );
    assert.deepEqual(
      combined.byScenario[scenario],
      armSummaries(campaign.runs),
      `${scenario} arm summaries`
    );
  }
  const allRuns = entries.flatMap(([, campaign]) => campaign.runs);
  const actualSummary = armSummaries(allRuns);
  assert.deepEqual(
    combined.summary,
    actualSummary,
    "combined confirmation.summary"
  );
  assert.deepEqual(
    combined.deltas,
    comparisonDeltas(actualSummary),
    "combined confirmation.deltas"
  );
  const actualRouteGuardrails = evaluateRouteGuardrails(combined.byScenario);
  assert.deepEqual(
    combined.routeGuardrails,
    actualRouteGuardrails,
    "combined confirmation.routeGuardrails"
  );
  assert.deepEqual(
    combined.confirmationConclusion,
    evaluateConfirmationConclusion(actualRouteGuardrails),
    "combined confirmation.confirmationConclusion"
  );
  return combined;
}

export function aggregateConfirmationRuns(runs) {
  const turns = runs.flatMap((run) => run.turns);
  const successful = turns.filter((turn) => turn.requestSuccessful);
  const warmSuccessful = successful.filter((turn) => turn.step > 0);
  const attributedWarm = warmSuccessful.filter(
    (turn) => turn.responseModelMatchesRequested === true
  );
  const tracked = attributedWarm.filter(
    (turn) =>
      turn.cachedTokens !== null &&
      turn.inputTokens !== null &&
      turn.usageEnvelopeValid
  );
  const writeTracked = attributedWarm.filter(
    (turn) => turn.cacheWriteTokens !== null && turn.usageEnvelopeValid
  );
  const trackedWarmCoordinates = runs
    .flatMap((run, runIndex) =>
      run.turns
        .filter(
          (turn) =>
            turn.step > 0 &&
            turn.requestSuccessful &&
            turn.responseModelMatchesRequested === true &&
            turn.cachedTokens !== null &&
            turn.inputTokens !== null &&
            turn.usageEnvelopeValid
        )
        .map(
          (turn) =>
            `${run.modelId ?? "synthetic"}:${run.replicate ?? runIndex}:${turn.step}`
        )
    )
    .sort();
  const trackedInputTokens = safeSum(
    tracked.map((turn) => turn.inputTokens),
    "tracked input tokens"
  );
  const trackedCacheReadTokens = safeSum(
    tracked.map((turn) => turn.cachedTokens),
    "tracked cache-read tokens"
  );
  const trackedCacheWriteTokens = safeSum(
    writeTracked.map((turn) => turn.cacheWriteTokens),
    "tracked cache-write tokens"
  );
  const latencies = successful.map((turn) => turn.latencyMs);
  const inputCounts = successful.flatMap((turn) =>
    turn.inputTokens === null ? [] : [turn.inputTokens]
  );
  return {
    accuracyRate: divide(
      turns.filter((turn) => turn.correct).length,
      turns.length
    ),
    cacheHitRate:
      trackedInputTokens === 0
        ? null
        : trackedCacheReadTokens / trackedInputTokens,
    cacheAttributionEligibleWarmRequests: attributedWarm.length,
    cacheWriteTelemetryCoverage:
      attributedWarm.length === 0
        ? null
        : writeTracked.length / attributedWarm.length,
    correctResponses: turns.filter((turn) => turn.correct).length,
    failures: turns.length - successful.length,
    httpAttempts: safeSum(
      turns.map((turn) => turn.attempts),
      "HTTP attempts"
    ),
    logicalTurns: turns.length,
    lengthFinishes: turns.filter((turn) => turn.finishReason === "length")
      .length,
    maxInputTokens: inputCounts.length === 0 ? null : Math.max(...inputCounts),
    medianLatencyMs: percentile(latencies, 0.5) ?? null,
    missingFinishReasons: successful.filter(
      (turn) => turn.finishReason === null
    ).length,
    p95LatencyMs: percentile(latencies, 0.95) ?? null,
    successfulTurns: successful.length,
    telemetryCoverage:
      attributedWarm.length === 0
        ? null
        : tracked.length / attributedWarm.length,
    tokenRecallCorrectResponses: turns.filter((turn) => turn.tokenRecallCorrect)
      .length,
    tokenRecallRate: divide(
      turns.filter((turn) => turn.tokenRecallCorrect).length,
      turns.length
    ),
    trackedCacheReadTokens:
      tracked.length === 0 ? null : trackedCacheReadTokens,
    trackedCacheWriteTokens:
      writeTracked.length === 0 ? null : trackedCacheWriteTokens,
    trackedInputTokens: tracked.length === 0 ? null : trackedInputTokens,
    trackedRequests: tracked.length,
    trackedWarmCoordinates,
    trackedUncachedTokens:
      tracked.length === 0 ? null : trackedInputTokens - trackedCacheReadTokens,
    responseModelAudit: aggregateResponseModelAudit(turns),
    warmSuccessfulTurns: warmSuccessful.length,
  };
}

export function confirmationMarkdown(combined) {
  verifyCombinedConfirmation(combined);
  const uniform = combined.summary.uniform;
  const routeAware = combined.summary["route-aware"];
  const rows = [
    markdownRow("Uniform 60K fallback", uniform),
    markdownRow("Route-aware exceptions", routeAware),
  ].join("\n");
  const routeRows = ["file-search", "conversation"]
    .map((scenario) =>
      routeMarkdownRow(scenario, combined.routeGuardrails[scenario])
    )
    .join("\n");
  const pooled = `Across both routes, the pooled descriptive totals measured ${percent(routeAware.cacheHitRate)} cache hit for route-aware versus ${percent(uniform.cacheHitRate)} for uniform, with strict correctness ${percent(routeAware.accuracyRate)} versus ${percent(uniform.accuracyRate)}. The pooled row is not used to accept either route.`;
  return `# Interleaved route-aware cache-policy confirmation

This checked-in snapshot combines two preregistered live campaigns run through
the OpenAI-compatible router on 2026-07-17. Each scenario used
\`uniform → route-aware → route-aware → uniform\`, two replicates per arm, six
turns per run, a fresh cache-isolation marker, and exactly one HTTP attempt per
logical turn.

**Overall preregistered result: ${combined.confirmationConclusion.status}.**
${combined.confirmationConclusion.reason}

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
${rows}

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

export function atomicWrite(path, content) {
  const absolutePath = resolve(path);
  assert.equal(
    dirname(absolutePath),
    evidenceRoot,
    "confirmation output must remain in the cache-telemetry evidence directory"
  );
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, absolutePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function assertNoForbiddenContent(value, label) {
  walk(value, (key, nested) => {
    assert.ok(
      ![
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
      ].includes(key),
      `${label} contains forbidden field ${key}`
    );
    if (typeof nested === "string") {
      assert.doesNotMatch(
        nested,
        CREDENTIAL_LIKE_PATTERN,
        `${label} contains a credential-like string`
      );
    }
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceManifest(entries) {
  const files = entries.map(([path, url]) => ({
    path,
    sha256: sha256(readFileSync(url)),
  }));
  return {
    files,
    manifestSha256: sha256(JSON.stringify(files)),
  };
}

function verifySourceManifest(manifest, label) {
  assertPlainObject(manifest, label);
  exactKeys(manifest, ["files", "manifestSha256"], label);
  assert.ok(Array.isArray(manifest.files), `${label}.files`);
  assert.ok(manifest.files.length > 0, `${label}.files must not be empty`);
  const paths = new Set();
  for (const [index, file] of manifest.files.entries()) {
    assertPlainObject(file, `${label}.files[${index}]`);
    exactKeys(file, ["path", "sha256"], `${label}.files[${index}]`);
    assert.ok(
      typeof file.path === "string" &&
        SAFE_MANIFEST_PATH_PATTERN.test(file.path),
      `${label}.files[${index}].path`
    );
    assert.match(
      file.sha256,
      SHA256_PATTERN,
      `${label}.files[${index}].sha256`
    );
    paths.add(file.path);
  }
  assert.equal(paths.size, manifest.files.length, `${label} duplicate paths`);
  assert.equal(
    manifest.manifestSha256,
    sha256(JSON.stringify(manifest.files)),
    `${label}.manifestSha256`
  );
}

function verifyConfig(config, route, label) {
  assertPlainObject(config, `${label}.config`);
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
  assert.equal(
    config.confirmationMode,
    true,
    `${label}.config.confirmationMode`
  );
  assert.deepEqual(
    config.confirmationOrder,
    CONFIRMATION_ORDER,
    `${label}.config.confirmationOrder`
  );
  assert.equal(
    config.highWaterTokens,
    75_000,
    `${label}.config.highWaterTokens`
  );
  assert.equal(
    config.maximumHttpAttemptsPerTurn,
    1,
    `${label}.config.maximumHttpAttemptsPerTurn`
  );
  assert.equal(config.steps, 6, `${label}.config.steps`);
  assert.equal(
    config.targetChunkCharacters,
    60_000,
    `${label}.config.targetChunkCharacters`
  );
  assertPlainObject(config.correctness, `${label}.config.correctness`);
  exactKeys(
    config.correctness,
    ["strict", "tokenRecallProxy"],
    `${label}.config.correctness`
  );
  assert.ok(
    typeof config.correctness.strict === "string" &&
      config.correctness.strict.includes("exactly the requested keys"),
    `${label}.config.correctness.strict`
  );
  assert.ok(
    typeof config.correctness.tokenRecallProxy === "string" &&
      config.correctness.tokenRecallProxy.includes("never substitutes"),
    `${label}.config.correctness.tokenRecallProxy`
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
    `${label}.config.models`
  );
}

function verifyFixtureManifest(fixture, route, label) {
  assertPlainObject(fixture, `${label}.fixture`);
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
  assert.equal(fixture.scenario, route.scenario, `${label}.fixture.scenario`);
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
  assert.match(
    fixture.fixtureSha256,
    SHA256_PATTERN,
    `${label}.fixture.fixtureSha256`
  );
  assert.ok(Array.isArray(fixture.chunks), `${label}.fixture.chunks`);
  assert.equal(fixture.chunks.length, 6, `${label}.fixture.chunks.length`);
  for (const [step, chunk] of fixture.chunks.entries()) {
    assertPlainObject(chunk, `${label}.fixture.chunks[${step}]`);
    exactKeys(
      chunk,
      ["characters", "expectedTokenCount", "step"],
      `${label}.fixture.chunks[${step}]`
    );
    assert.equal(chunk.step, step, `${label}.fixture.chunks[${step}].step`);
    assert.ok(
      Number.isSafeInteger(chunk.characters) &&
        chunk.characters >= 60_000 &&
        chunk.characters <= 1_000_000,
      `${label}.fixture.chunks[${step}].characters`
    );
    assert.equal(
      chunk.expectedTokenCount,
      route.scenario === "conversation" ? 2 : 1,
      `${label}.fixture.chunks[${step}].expectedTokenCount`
    );
  }
}

function verifyModelCatalog(catalog, modelId, label) {
  assertPlainObject(catalog, `${label}.modelCatalog`);
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
  assert.equal(catalog.httpStatus, 200, `${label}.modelCatalog.httpStatus`);
  assert.deepEqual(
    catalog.requestedModelIds,
    [modelId],
    `${label}.modelCatalog.requestedModelIds`
  );
  assert.deepEqual(
    catalog.presentModelIds,
    [modelId],
    `${label}.modelCatalog.presentModelIds`
  );
  assert.equal(catalog.status, "passed", `${label}.modelCatalog.status`);
}

function verifyConfirmationRun(run, { arm, index, label, route }) {
  assertPlainObject(run, label);
  exactKeys(run, RUN_KEYS, label);
  assert.equal(run.arm, arm, `${label}.arm`);
  assert.equal(run.orderIndex, index, `${label}.orderIndex`);
  assert.equal(
    run.replicate,
    index === 0 || index === 1 ? 1 : 2,
    `${label}.replicate`
  );
  assert.equal(run.modelId, route.modelId, `${label}.modelId`);
  assert.equal(run.policy, "high-water-stable-prefix", `${label}.policy`);
  assert.match(
    run.cacheIsolationKeySha256,
    SHA256_PATTERN,
    `${label}.cacheIsolationKeySha256`
  );
  const expectedArm = route.arms[arm];
  assert.equal(
    run.highWaterTokens,
    expectedArm.highWaterTokens,
    `${label}.highWaterTokens`
  );
  assert.equal(
    run.maxOutputTokens,
    expectedArm.maxOutputTokens,
    `${label}.maxOutputTokens`
  );
  assert.ok(Array.isArray(run.turns), `${label}.turns must be an array`);
  assert.equal(run.turns.length, 6, `${label}.turns.length`);
  for (const [step, turn] of run.turns.entries()) {
    verifyConfirmationTurn(
      turn,
      route.modelId,
      `${label}.turns[${step}]`,
      step
    );
  }
  assert.ok(
    Array.isArray(run.compactionTriggers),
    `${label}.compactionTriggers`
  );
  for (const [triggerIndex, value] of run.compactionTriggers.entries()) {
    assertSafeToken(value, `${label}.compactionTriggers[${triggerIndex}]`);
  }
  assert.equal(
    run.compactions,
    run.compactionTriggers.length,
    `${label}.compactions`
  );
  const actual = aggregateConfirmationRuns([run]);
  verifyFields(
    run,
    {
      accuracyRate: actual.accuracyRate,
      cacheHitRate: actual.cacheHitRate,
      cacheAttributionEligibleWarmRequests:
        actual.cacheAttributionEligibleWarmRequests,
      cacheWriteTelemetryCoverage: actual.cacheWriteTelemetryCoverage,
      failures: actual.failures,
      maxInputTokens: actual.maxInputTokens,
      medianLatencyMs: actual.medianLatencyMs,
      missingFinishReasons: actual.missingFinishReasons,
      p95LatencyMs: actual.p95LatencyMs,
      telemetryCoverage: actual.telemetryCoverage,
      tokenRecallRate: actual.tokenRecallRate,
      trackedCacheReadTokens: actual.trackedCacheReadTokens,
      trackedCacheWriteTokens: actual.trackedCacheWriteTokens,
      trackedInputTokens: actual.trackedInputTokens,
      trackedRequests: actual.trackedRequests,
    },
    label
  );
  assert.deepEqual(
    run.responseModelAudit,
    responseModelAudit(run.turns, route.modelId),
    `${label}.responseModelAudit`
  );
}

function verifyConfirmationTurn(turn, requestedModel, label, step) {
  assertPlainObject(turn, label);
  exactKeys(turn, TURN_KEYS, label);
  assert.equal(turn.step, step, `${label}.step`);
  assert.equal(turn.attempts, 1, `${label}.attempts`);
  assertBoolean(turn.correct, `${label}.correct`);
  assertBoolean(turn.tokenRecallCorrect, `${label}.tokenRecallCorrect`);
  assertBoolean(turn.requestSuccessful, `${label}.requestSuccessful`);
  assertBoolean(turn.cacheFieldReported, `${label}.cacheFieldReported`);
  assertBoolean(
    turn.cacheWriteFieldReported,
    `${label}.cacheWriteFieldReported`
  );
  assertBoolean(turn.usageEnvelopeValid, `${label}.usageEnvelopeValid`);
  assertSafeTokenOrNull(turn.cachedTokens, `${label}.cachedTokens`);
  assertSafeTokenOrNull(turn.cacheWriteTokens, `${label}.cacheWriteTokens`);
  assertSafeTokenOrNull(turn.inputTokens, `${label}.inputTokens`);
  assertSafeToken(turn.latencyMs, `${label}.latencyMs`);
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
  assert.ok(
    turn.responseModelMatchesRequested === null ||
      typeof turn.responseModelMatchesRequested === "boolean",
    `${label}.responseModelMatchesRequested`
  );
  verifyResponseAttribution(turn, requestedModel, label);
  if (!turn.requestSuccessful) {
    assert.equal(turn.correct, false, `${label} failed strict correctness`);
    assert.equal(
      turn.tokenRecallCorrect,
      false,
      `${label} failed token recall correctness`
    );
  }
  assertPlainObject(turn.usageFieldAudit, `${label}.usageFieldAudit`);
  exactKeys(
    turn.usageFieldAudit,
    ["cacheRead", "cacheWrite", "input"],
    `${label}.usageFieldAudit`
  );
  for (const [key, status] of Object.entries(turn.usageFieldAudit)) {
    assert.ok(
      USAGE_AUDIT_STATUSES.has(status),
      `${label}.usageFieldAudit.${key}`
    );
  }
  verifyUsageAuditValue(
    turn.usageFieldAudit.cacheRead,
    turn.cachedTokens,
    turn.cacheFieldReported,
    `${label}.cacheRead`
  );
  verifyUsageAuditValue(
    turn.usageFieldAudit.cacheWrite,
    turn.cacheWriteTokens,
    turn.cacheWriteFieldReported,
    `${label}.cacheWrite`
  );
  verifyUsageAuditValue(
    turn.usageFieldAudit.input,
    turn.inputTokens,
    turn.inputTokens !== null,
    `${label}.input`
  );
  assert.equal(
    turn.usageEnvelopeValid,
    validUsageEnvelope(turn),
    `${label}.usageEnvelopeValid`
  );
}

export function verifyResponseAttribution(
  turn,
  requestedModel,
  label = "turn"
) {
  const expectedMatch =
    turn.responseModel === null ? null : turn.responseModel === requestedModel;
  assert.equal(
    turn.responseModelMatchesRequested,
    expectedMatch,
    `${label}.responseModelMatchesRequested`
  );
  if (turn.requestSuccessful) {
    assert.equal(turn.httpStatus, 200, `${label} successful HTTP status`);
    assert.equal(turn.errorClass, null, `${label} successful errorClass`);
  }
}

function verifyUsageAuditValue(status, value, reported, label) {
  if (status === "valid") {
    assert.notEqual(value, null, `${label} valid value`);
    assert.equal(reported, true, `${label} reported`);
    return;
  }
  assert.equal(value, null, `${label} ${status} value`);
  assert.equal(reported, false, `${label} ${status} reported`);
}

function validUsageEnvelope(turn) {
  if (turn.usageFieldAudit.input !== "valid" || turn.inputTokens === null) {
    return false;
  }
  if (
    !(
      ["absent", "valid"].includes(turn.usageFieldAudit.cacheRead) &&
      ["absent", "valid"].includes(turn.usageFieldAudit.cacheWrite)
    )
  ) {
    return false;
  }
  const read = turn.cachedTokens;
  const write = turn.cacheWriteTokens;
  return !(
    (read !== null && read > turn.inputTokens) ||
    (write !== null && write > turn.inputTokens) ||
    (read !== null && write !== null && read + write > turn.inputTokens)
  );
}

function responseModelAudit(turns, requestedModel) {
  const observed = new Map();
  for (const turn of turns) {
    if (turn.responseModel !== null) {
      observed.set(
        turn.responseModel,
        (observed.get(turn.responseModel) ?? 0) + 1
      );
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
    observedModels: Object.fromEntries(observed),
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

function expectedRoute(scenario) {
  if (scenario === "file-search") {
    return {
      arms: {
        "route-aware": { highWaterTokens: 75_000, maxOutputTokens: 160 },
        uniform: { highWaterTokens: 60_000, maxOutputTokens: 160 },
      },
      configMaxOutputTokens: 160,
      contextLength: 262_144,
      modelId: "mistralai/ministral-14b-latest",
      scenario,
    };
  }
  if (scenario === "conversation") {
    return {
      arms: {
        "route-aware": { highWaterTokens: 75_000, maxOutputTokens: 256 },
        uniform: { highWaterTokens: 60_000, maxOutputTokens: 512 },
      },
      configMaxOutputTokens: 256,
      contextLength: 204_800,
      modelId: "minimaxai/minimax-m2.7",
      scenario,
    };
  }
  throw new Error(`unsupported confirmation scenario: ${String(scenario)}`);
}

function currentFixtureManifest(scenario) {
  const env = {
    ...process.env,
    FREEROUTER_API_KEY: "",
    FREEROUTER_BASE_URL: "",
    PSS_LIVE_CHUNK_CHARACTERS: "60000",
    PSS_LIVE_CONFIRMATION: "",
    PSS_LIVE_FIXTURE_ONLY: "true",
    PSS_LIVE_HIGH_WATER_TOKENS: "75000",
    PSS_LIVE_MINIMAX_MAX_OUTPUT_TOKENS: "256",
    PSS_LIVE_MODELS: "",
    PSS_LIVE_POLICIES: "",
    PSS_LIVE_STEPS: "6",
  };
  const output = execFileSync(process.execPath, [runnerPath, scenario], {
    encoding: "utf8",
    env,
    maxBuffer: 1_000_000,
    timeout: 30_000,
  });
  return JSON.parse(output);
}

function armSummaries(runs) {
  return Object.fromEntries(
    ["uniform", "route-aware"].map((arm) => [
      arm,
      aggregateConfirmationRuns(runs.filter((run) => run.arm === arm)),
    ])
  );
}

function comparisonDeltas(summary) {
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
      uncachedTokens(routeAware),
      uncachedTokens(uniform)
    ),
  };
}

export function evaluateRouteGuardrails(byScenario) {
  return Object.fromEntries(
    ["conversation", "file-search"].map((scenario) => [
      scenario,
      routeGuardrailResult(byScenario[scenario]),
    ])
  );
}

function routeGuardrailResult(summary) {
  const uniform = summary.uniform;
  const routeAware = summary["route-aware"];
  const observed = {
    "route-aware": guardrailObservation(routeAware),
    uniform: guardrailObservation(uniform),
  };
  const trackedCoordinatesMatch =
    JSON.stringify(uniform.trackedWarmCoordinates) ===
    JSON.stringify(routeAware.trackedWarmCoordinates);
  const indeterminateReasons = routeIndeterminateReasons(
    observed,
    uniform,
    routeAware,
    trackedCoordinatesMatch
  );
  const failedGuardrails = routeFailedGuardrails(
    uniform,
    routeAware,
    trackedCoordinatesMatch
  );
  return {
    failedGuardrails,
    indeterminateReasons,
    observed,
    status: routeGuardrailStatus(indeterminateReasons, failedGuardrails),
  };
}

function routeIndeterminateReasons(
  observed,
  uniform,
  routeAware,
  trackedCoordinatesMatch
) {
  const reasons = [];
  for (const [arm, value] of Object.entries(observed)) {
    if (value.logicalTurns !== 12 || value.successfulTurns !== 12) {
      reasons.push(`${arm}:not-all-turns-succeeded`);
    }
    if (
      value.exactResponseModelCoverage !==
      CONFIRMATION_GUARDRAILS.exactResponseModelCoverage
    ) {
      reasons.push(`${arm}:response-model-attribution-below-1`);
    }
    if (value.cacheAttributionEligibleWarmRequests !== 10) {
      reasons.push(`${arm}:warm-attribution-incomplete`);
    }
    if (value.missingFinishReasons !== 0) {
      reasons.push(`${arm}:finish-reason-incomplete`);
    }
    if (
      value.telemetryCoverage === null ||
      value.telemetryCoverage < CONFIRMATION_GUARDRAILS.minTelemetryCoverage ||
      value.trackedRequests < CONFIRMATION_GUARDRAILS.minTrackedWarmRequests
    ) {
      reasons.push(`${arm}:cache-telemetry-below-minimum`);
    }
    if (
      value.cacheHitRate === null ||
      value.trackedUncachedTokens === null ||
      value.p95LatencyMs === null
    ) {
      reasons.push(`${arm}:comparison-metric-unavailable`);
    }
  }
  if (uniform.trackedRequests !== routeAware.trackedRequests) {
    reasons.push("arms:tracked-request-count-mismatch");
  }
  if (!trackedCoordinatesMatch) {
    reasons.push("arms:tracked-coordinate-mismatch");
  }
  return reasons;
}

function routeFailedGuardrails(uniform, routeAware, trackedCoordinatesMatch) {
  const failures = [];
  if (uniform.accuracyRate !== 1 || routeAware.accuracyRate !== 1) {
    failures.push("perfect-strict-correctness");
  }
  if (routeAware.accuracyRate < uniform.accuracyRate) {
    failures.push("strict-correctness-regression");
  }
  if (
    trackedCoordinatesMatch &&
    routeAware.cacheHitRate !== null &&
    uniform.cacheHitRate !== null &&
    routeAware.cacheHitRate < uniform.cacheHitRate
  ) {
    failures.push("cache-hit-regression");
  }
  if (
    trackedCoordinatesMatch &&
    routeAware.trackedUncachedTokens !== null &&
    uniform.trackedUncachedTokens !== null &&
    routeAware.trackedUncachedTokens > uniform.trackedUncachedTokens
  ) {
    failures.push("tracked-uncached-token-regression");
  }
  if (
    uniform.successfulTurns === uniform.logicalTurns &&
    routeAware.successfulTurns === routeAware.logicalTurns &&
    routeAware.p95LatencyMs !== null &&
    uniform.p95LatencyMs !== null &&
    routeAware.p95LatencyMs > uniform.p95LatencyMs
  ) {
    failures.push("p95-latency-regression");
  }
  if (uniform.lengthFinishes !== 0 || routeAware.lengthFinishes !== 0) {
    failures.push("length-finish-present");
  }
  return failures;
}

function routeGuardrailStatus(indeterminateReasons, failedGuardrails) {
  if (failedGuardrails.length > 0) {
    return "fail";
  }
  if (indeterminateReasons.length > 0) {
    return "indeterminate";
  }
  return "pass";
}

function guardrailObservation(summary) {
  return {
    accuracyRate: summary.accuracyRate,
    cacheAttributionEligibleWarmRequests:
      summary.cacheAttributionEligibleWarmRequests,
    cacheHitRate: summary.cacheHitRate,
    exactResponseModelCoverage: divide(
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
    trackedWarmCoordinates: summary.trackedWarmCoordinates,
    trackedUncachedTokens: summary.trackedUncachedTokens,
  };
}

export function evaluateConfirmationConclusion(routeGuardrails) {
  const entries = Object.entries(routeGuardrails);
  const statuses = entries.map(([, result]) => result.status);
  if (statuses.every((status) => status === "pass")) {
    return {
      reason:
        "Both route exceptions passed every preregistered route-specific evidence and non-regression guardrail.",
      status: "pass",
    };
  }
  if (statuses.some((status) => status === "fail")) {
    const failed = entries
      .filter(([, result]) => result.status === "fail")
      .map(([scenario]) => scenario)
      .join(", ");
    return {
      reason: `At least one route had a directly observed correctness, completion, or comparable-metric guardrail failure: ${failed}.`,
      status: "fail",
    };
  }
  const indeterminate = entries
    .filter(([, result]) => result.status === "indeterminate")
    .map(([scenario]) => scenario)
    .join(", ");
  return {
    reason: `At least one route lacked the preregistered attribution, telemetry coverage, or completion metadata needed for a conclusion: ${indeterminate}.`,
    status: "indeterminate",
  };
}

function uncachedTokens(summary) {
  return summary.trackedInputTokens === null ||
    summary.trackedCacheReadTokens === null
    ? null
    : summary.trackedInputTokens - summary.trackedCacheReadTokens;
}

function nullableDifference(left, right) {
  return left === null || right === null ? null : left - right;
}

function markdownRow(label, summary) {
  return `| ${label} | ${percent(summary.accuracyRate)} (${summary.correctResponses}/${summary.logicalTurns}) | ${percent(summary.tokenRecallRate)} | ${percent(summary.cacheHitRate)} | ${coverage(summary.trackedRequests, summary.cacheAttributionEligibleWarmRequests)} | ${percent(summary.cacheWriteTelemetryCoverage)} | ${summary.responseModelAudit.exactRequestedModel}/${summary.responseModelAudit.turns} | ${milliseconds(summary.medianLatencyMs)} | ${milliseconds(summary.p95LatencyMs)} | ${summary.successfulTurns}/${summary.logicalTurns} |`;
}

function routeMarkdownRow(scenario, result) {
  const uniform = result.observed.uniform;
  const routeAware = result.observed["route-aware"];
  const label =
    scenario === "file-search"
      ? "Ministral file search"
      : "MiniMax conversation";
  return `| ${label} | ${result.status} | ${fraction(uniform.accuracyRate, uniform.logicalTurns)} → ${fraction(routeAware.accuracyRate, routeAware.logicalTurns)} | ${percent(uniform.cacheHitRate)} → ${percent(routeAware.cacheHitRate)} | ${coverage(uniform.trackedRequests, uniform.cacheAttributionEligibleWarmRequests)} → ${coverage(routeAware.trackedRequests, routeAware.cacheAttributionEligibleWarmRequests)} | ${numberOrNa(uniform.trackedUncachedTokens)} → ${numberOrNa(routeAware.trackedUncachedTokens)} | ${milliseconds(uniform.p95LatencyMs)} → ${milliseconds(routeAware.p95LatencyMs)} | ${percent(uniform.exactResponseModelCoverage)} → ${percent(routeAware.exactResponseModelCoverage)} |`;
}

function fraction(rate, total) {
  return rate === null ? "n/a" : `${Math.round(rate * total)}/${total}`;
}

function numberOrNa(value) {
  return value === null ? "n/a" : value.toLocaleString("en-US");
}

function coverage(tracked, warmDenominator) {
  return warmDenominator === 0 ? "n/a" : `${tracked}/${warmDenominator}`;
}

function percent(value) {
  return value === null || value === undefined
    ? "n/a"
    : `${(value * 100).toFixed(2)}%`;
}

function milliseconds(value) {
  return value === null ? "n/a" : `${(value / 1000).toFixed(3)} s`;
}

function canonicalJsonSha256(value) {
  return sha256(JSON.stringify(value));
}

function verifyFields(recorded, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(
      Object.hasOwn(recorded, key),
      `${label}.${key}: missing expected field`
    );
    const observed = recorded[key];
    if (typeof value === "number" && typeof observed === "number") {
      assert.ok(Number.isFinite(observed), `${label}.${key} must be finite`);
      const tolerance = Math.max(1, Math.abs(value)) * 1e-12;
      assert.ok(
        Math.abs(observed - value) <= tolerance,
        `${label}.${key}: expected ${value}, recorded ${observed}`
      );
      continue;
    }
    assert.deepEqual(observed, value, `${label}.${key}`);
  }
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

function assertBoolean(value, label) {
  assert.equal(typeof value, "boolean", `${label} must be boolean`);
}

function assertSafeToken(value, label) {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a safe token count`
  );
}

function assertSafeTokenOrNull(value, label) {
  if (value !== null) {
    assertSafeToken(value, label);
  }
}

function assertIsoTimestamp(value, label) {
  assert.ok(
    typeof value === "string" &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    `${label} must be an ISO timestamp`
  );
}

function safeSum(values, label) {
  let total = 0;
  for (const value of values) {
    assertSafeToken(value, label);
    total += value;
    assert.ok(
      Number.isSafeInteger(total),
      `${label} exceeded the safe integer range`
    );
  }
  return total;
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
  return denominator === 0 ? null : numerator / denominator;
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
