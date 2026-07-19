import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveModelViews,
  deriveResponseIdAudit,
  EXPECTED_CAMPAIGN_ID,
  EXPECTED_MODELS,
  EXPECTED_TOPOLOGY,
  pairOrderFor,
  REQUIRED_IMPLEMENTATION_SOURCE_PATHS,
  requestArtifacts,
  responseIdDuplicateSets,
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
const SYNTHETIC_BACKEND_PATTERN = /synthetic-backend-[ab]/u;
const EXPECTED_VERIFIER_IMPORTS = [
  "node:child_process",
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
      "Each model/scenario/trial execution slot (first or second) has a unique, fixed-length token in an equal-shape inert canary placed before every benchmark tool. Warmup and measure reuse the slot canary; alternating AB/BA order counterbalances each variant across slots.",
    promptNamespace:
      "Each model/scenario/trial execution slot has a unique, fixed-length system-message namespace shared only by its warmup and measurement; it is not derived from control/changed identity.",
  },
  backendMetadataSemantics:
    "Nullable system_fingerprint and service_tier response fields are retained only as absent/null/invalid/hashed statuses plus SHA-256 digests. Multiple digests are reported as possible backend drift. These fields do not change per-request cache-telemetry eligibility, but matched non-null values gate primary paired sensitivity eligibility; raw values and raw provider payloads are never stored.",
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
  eligibilitySemantics: {
    cacheTelemetryEligible:
      "A capture-success request is locally eligible for requested-model cache aggregation only when the sanitized response model exactly matches the requested model and input/cache-read/cache-write usage aliases form a valid envelope. A measured request additionally requires its own arm's warmup to be a capture success from that exact requested model.",
    captureSuccess:
      "HTTP success plus exactly one recognized choice/message, zero modern or legacy tool calls, finish_reason=stop, and exact trimmed text OK. Response-model attribution and usage validity are audited separately. HTTP failures retain only status-derived codes and local failures use a fixed allowlist; provider error strings are never retained or logged.",
  },
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
    "descriptive-control-higher"
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

test("rejects a source manifest hash that is not backed by frozen bytes", async () => {
  const evidence = await copyPristine();
  evidence.configuration.implementationSourcesSha256[
    "packages/runtime/src/llm/llm.ts"
  ] = "0".repeat(64);
  await rejectsWith(evidence, ["implementationSourcesSha256"]);
});

test("requires runtime build and validation configs in the source manifest", async () => {
  const evidence = await copyPristine();
  evidence.configuration.implementationSourcesSha256 = Object.fromEntries(
    Object.entries(evidence.configuration.implementationSourcesSha256).filter(
      ([sourcePath]) => sourcePath !== "biome.jsonc"
    )
  );
  await rejectsWith(evidence, ["implementationSourcesSha256"]);
});

test("rejects a false clean-at-start attestation and mismatched freeze tree", async () => {
  const dirty = await copyPristine();
  dirty.configuration.sourceWorktreeCleanAtStart = false;
  await rejectsWith(dirty, ["sourceWorktreeCleanAtStart"]);

  const wrongCommit = await copyPristine();
  wrongCommit.configuration.sourceFreezeCommitSha = execFileSync(
    "git",
    ["rev-parse", "--verify", "HEAD^"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  ).trim();
  await rejectsWith(wrongCommit, ["sourceFreezeCommit"]);
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

test("rejects an OpenAI-style credential hidden behind JSON escapes", async () => {
  const evidence = await copyPristine();
  evidence.configuration.nodeVersion = "sk-synthetic-forged-credential";
  const serialized = `${JSON.stringify(evidence, null, 2).replace(
    "sk-synthetic-forged-credential",
    "sk\\u002dsynthetic-forged-credential"
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

test("rejects a campaign response-ID audit tamper", async () => {
  const evidence = await copyPristine();
  evidence.responseIdAudit.reported -= 1;
  await rejectsWith(evidence, [
    "evidence.responseIdAudit",
    "independent recomputation",
  ]);
});

test("rejects a membership parity audit tamper", async () => {
  const evidence = await copyPristine();
  evidence.models[0].membershipInputTokenParityAudit.equal -= 1;
  await rejectsWith(evidence, [
    "membershipInputTokenParityAudit",
    "independent recomputation",
  ]);
});

test("rejects a primary membership parity audit tamper", async () => {
  const evidence = await copyPristine();
  evidence.models[0].primaryMembershipInputTokenParityAudit.equal -= 1;
  await rejectsWith(evidence, [
    "primaryMembershipInputTokenParityAudit",
    "independent recomputation",
  ]);
});

test("rejects a weighted aggregate tamper", async () => {
  const evidence = await copyPristine();
  evidence.models[0].summaries[0].weightedCacheReadRatio = 0.123;
  await rejectsWith(evidence, ["summaries", "independent recomputation"]);
});

test("reports hashed backend drift without retaining raw metadata", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  model.requests[0].systemFingerprintSha256 = sha256("synthetic-backend-b");
  refreshModel(model);
  const result = await verify(evidence);

  assert.deepEqual(model.backendMetadataAudit.systemFingerprint, {
    driftObserved: true,
    statusCounts: { absent: 0, hashed: 96, invalid: 0, null: 0 },
    uniqueHashCount: 2,
  });
  assert.equal(
    result.report.models[0].backendMetadataAudit.systemFingerprint
      .driftObserved,
    true
  );
  assert.doesNotMatch(JSON.stringify(evidence), SYNTHETIC_BACKEND_PATTERN);
});

test("keeps mismatched backend hashes descriptive but excludes the primary pair", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const changed = model.requests.find(
    (request) =>
      request.phase === "measure" &&
      request.scenario === "same-set-order" &&
      request.variant === "reversed-order"
  );
  changed.systemFingerprintSha256 = sha256("different-backend");
  refreshModel(model);
  const result = await verify(evidence);
  const allSample = model.comparisons[0];
  const primary = model.primaryComparisons[0];
  const effect = result.report.effects.find(
    (item) => item.scope === model.model && item.scenario === "same-set-order"
  );

  assert.equal(allSample.systemFingerprintPairStatuses.mismatched, 1);
  assert.equal(allSample.eligiblePairs, 8);
  assert.equal(primary.eligiblePairs, 7);
  assert.equal(effect.conclusion, "insufficient-coverage");
  assert.equal(
    effect.allSampleDescriptive.conclusion,
    "descriptive-control-higher"
  );
});

test("excludes a pair when an arm crosses backends between warmup and measure", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const warmup = model.requests.find(
    (request) =>
      request.phase === "warmup" &&
      request.scenario === "same-set-order" &&
      request.variant === "reversed-order"
  );
  warmup.serviceTierSha256 = sha256("different-service-tier");
  refreshModel(model);
  const result = await verify(evidence);
  const effect = result.report.effects.find(
    (item) => item.scope === model.model && item.scenario === "same-set-order"
  );

  assert.equal(model.comparisons[0].serviceTierPairStatuses.mismatched, 1);
  assert.equal(model.comparisons[0].eligiblePairs, 8);
  assert.equal(model.primaryComparisons[0].eligiblePairs, 7);
  assert.equal(effect.conclusion, "insufficient-coverage");
  assert.equal(
    effect.allSampleDescriptive.conclusion,
    "descriptive-control-higher"
  );
});

test("uses the cache-primary pair universe for membership parity", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const warmup = model.requests.find(
    (request) =>
      request.phase === "warmup" &&
      request.scenario === "membership-only-change" &&
      request.variant === "changed-membership"
  );
  warmup.serviceTierSha256 = sha256("different-service-tier");
  refreshModel(model);
  const result = await verify(evidence);
  const parity = result.report.membershipInputParity.find(
    (item) => item.scope === model.model
  );

  assert.equal(model.membershipInputTokenParityAudit.eligiblePairs, 8);
  assert.equal(model.primaryMembershipInputTokenParityAudit.eligiblePairs, 7);
  assert.equal(parity.conclusion, "insufficient-coverage");
  assert.equal(parity.allSampleDescriptive.conclusion, "input-token-parity");
});

test("excludes response IDs duplicated across distinct request bodies", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const pair = model.requests.filter(
    (request) =>
      request.phase === "measure" &&
      request.scenario === "same-set-order" &&
      request.trial === 1
  );
  assert.equal(pair.length, 2);
  pair[1].responseIdSha256 = pair[0].responseIdSha256;
  assert.notEqual(pair[0].requestBodySha256, pair[1].requestBodySha256);
  refreshEvidence(evidence);
  const result = await verify(evidence);
  const effect = result.report.effects.find(
    (item) => item.scope === model.model && item.scenario === "same-set-order"
  );

  assert.deepEqual(model.responseIdAudit, {
    crossRequestBodyDuplicateHashes: 1,
    crossRequestBodyDuplicateObservations: 2,
    distinct: 95,
    duplicateHashes: 1,
    duplicateObservations: 1,
    reported: 96,
  });
  assert.equal(
    model.comparisons[0].responseIdIntegrityStatuses.crossBodyDuplicate,
    1
  );
  assert.equal(model.primaryComparisons[0].eligiblePairs, 7);
  assert.equal(effect.conclusion, "insufficient-coverage");
});

test("excludes a same-body response ID replay from the primary view", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const requests = model.requests.filter(
    (request) =>
      request.scenario === "membership-only-change" &&
      request.trial === 1 &&
      request.variant === "unchanged-membership"
  );
  assert.equal(requests.length, 2);
  const warmup = requests.find((request) => request.phase === "warmup");
  const measured = requests.find((request) => request.phase === "measure");
  assert.equal(warmup.requestBodySha256, measured.requestBodySha256);
  measured.responseIdSha256 = warmup.responseIdSha256;
  refreshEvidence(evidence);
  const result = await verify(evidence);

  assert.deepEqual(evidence.responseIdAudit, {
    crossRequestBodyDuplicateHashes: 0,
    crossRequestBodyDuplicateObservations: 0,
    distinct: 479,
    duplicateHashes: 1,
    duplicateObservations: 1,
    reported: 480,
  });
  assert.equal(model.comparisons[2].responseIdIntegrityStatuses.duplicate, 1);
  assert.equal(model.primaryComparisons[2].eligiblePairs, 7);
  assert.equal(model.primaryMembershipInputTokenParityAudit.eligiblePairs, 7);
  assert.equal(
    result.report.effects.find(
      (item) =>
        item.scope === model.model && item.scenario === "membership-only-change"
    ).conclusion,
    "insufficient-coverage"
  );
  const parity = result.report.membershipInputParity.find(
    (item) => item.scope === model.model
  );
  assert.equal(parity.conclusion, "insufficient-coverage");
  assert.equal(parity.allSampleDescriptive.conclusion, "input-token-parity");
});

test("excludes campaign-global response IDs reused across models", async () => {
  const evidence = await copyPristine();
  const firstModel = evidence.models[0];
  const secondModel = evidence.models[1];
  const firstRequest = firstModel.requests.find(
    (request) =>
      request.phase === "measure" &&
      request.scenario === "membership-only-change"
  );
  const secondRequest = secondModel.requests.find(
    (request) =>
      request.phase === "measure" &&
      request.scenario === "membership-only-change"
  );
  assert.notEqual(
    firstRequest.requestBodySha256,
    secondRequest.requestBodySha256
  );
  secondRequest.responseIdSha256 = firstRequest.responseIdSha256;
  refreshEvidence(evidence);
  const result = await verify(evidence);

  assert.deepEqual(evidence.responseIdAudit, {
    crossRequestBodyDuplicateHashes: 1,
    crossRequestBodyDuplicateObservations: 2,
    distinct: 479,
    duplicateHashes: 1,
    duplicateObservations: 1,
    reported: 480,
  });
  for (const model of [firstModel, secondModel]) {
    assert.equal(model.responseIdAudit.duplicateHashes, 0);
    assert.equal(
      model.comparisons[2].responseIdIntegrityStatuses.crossBodyDuplicate,
      1
    );
    assert.equal(model.primaryComparisons[2].eligiblePairs, 7);
    assert.equal(model.primaryMembershipInputTokenParityAudit.eligiblePairs, 7);
    assert.equal(
      result.report.effects.find(
        (item) =>
          item.scope === model.model &&
          item.scenario === "membership-only-change"
      ).conclusion,
      "insufficient-coverage"
    );
    const parity = result.report.membershipInputParity.find(
      (item) => item.scope === model.model
    );
    assert.equal(parity.conclusion, "insufficient-coverage");
    assert.equal(parity.allSampleDescriptive.conclusion, "input-token-parity");
  }
  assert.deepEqual(result.report.responseIdAudit, evidence.responseIdAudit);
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

test("withholds a directional effect when an order stratum is incomplete", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const targetTrials = trialsForOrder(
    model.model,
    "same-set-order",
    "control-first"
  ).slice(0, 1);
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

test("counts only positive-input pairs toward cache-ratio coverage", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const targetTrials = trialsForOrder(
    model.model,
    "same-set-order",
    "control-first"
  ).slice(0, 3);
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      request.scenario === "same-set-order" &&
      targetTrials.includes(request.trial)
    ) {
      request.cacheReadTokens = 0;
      request.inputTokens = 0;
      request.totalTokens = 1;
    }
  }
  refreshModel(model);
  const stableSummary = model.summaries.find(
    (summary) => summary.variant === "stable-order"
  );
  assert.equal(stableSummary.cacheReadReported, 8);
  assert.equal(stableSummary.cacheReadRatioEligible, 5);
  assert.equal(stableSummary.cacheReportCoverage, 1);
  assert.equal(stableSummary.cacheReadRatioCoverage, 5 / 8);
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

test("does not call cancelling input-token deltas exact parity", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  for (const pairOrder of ["control-first", "changed-first"]) {
    const deltas = [-10, 0, 0, 10];
    for (const [index, trial] of trialsForOrder(
      model.model,
      "membership-only-change",
      pairOrder
    ).entries()) {
      for (const request of model.requests) {
        if (
          request.phase !== "measure" ||
          request.scenario !== "membership-only-change" ||
          request.trial !== trial
        ) {
          continue;
        }
        const delta = deltas[index];
        request.inputTokens =
          request.variant === "unchanged-membership" ? 100 : 100 - delta;
        request.totalTokens = request.inputTokens + 1;
      }
    }
  }
  refreshModel(model);
  const result = await verify(evidence);
  const effect = result.report.membershipInputParity.find(
    (item) => item.scope === model.model
  );
  assert.equal(effect.conclusion, "no-observed-median-input-token-difference");
  assert.equal(model.membershipInputTokenParityAudit.equal, 4);
  assert.equal(model.membershipInputTokenParityAudit.controlHigher, 2);
  assert.equal(model.membershipInputTokenParityAudit.changedHigher, 2);
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
  assert.equal(
    result.report.effects.find(
      (effect) =>
        effect.scope === "pooled" && effect.scenario === "same-set-order"
    ).conclusion,
    "model-heterogeneous/indeterminate"
  );
});

test("withholds pooled input parity when one model is directional", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      request.scenario === "membership-only-change"
    ) {
      request.inputTokens =
        request.variant === "unchanged-membership" ? 110 : 100;
      request.totalTokens = request.inputTokens + 1;
    }
  }
  refreshModel(model);
  const result = await verify(evidence);
  assert.equal(
    result.report.membershipInputParity.find(
      (effect) => effect.scope === model.model
    ).conclusion,
    "descriptive-control-higher-input"
  );
  assert.equal(
    result.report.membershipInputParity.find(
      (effect) => effect.scope === "pooled"
    ).conclusion,
    "model-heterogeneous/indeterminate"
  );
});

test("marks opposing raw-token and ratio directions denominator-sensitive", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      request.scenario === "active-set-change"
    ) {
      const control = request.variant === "unchanged-active-set";
      request.cacheReadTokens = control ? 100 : 90;
      request.inputTokens = control ? 200 : 100;
      request.totalTokens = request.inputTokens + 1;
    }
  }
  refreshModel(model);
  const result = await verify(evidence);
  const effect = result.report.effects.find(
    (item) =>
      item.scope === model.model && item.scenario === "active-set-change"
  );
  assert.equal(effect.conclusion, "denominator-sensitive/indeterminate");
  assert.equal(
    effect.primary.endpoints.rawCacheReadTokens.conclusion,
    "descriptive-control-higher"
  );
  assert.equal(
    effect.primary.endpoints.cacheReadInputCoverageRatio.conclusion,
    "descriptive-changed-higher"
  );
  assert.ok(
    effect.primary.endpoints.cacheReadInputCoverageRatio.orderStrata.every(
      (stratum) => stratum.median < 0
    ),
    "each AB/BA stratum should report the changed arm's higher read ratio"
  );
  assert.deepEqual(model.comparisons[1].cacheReadTokenDifferenceSigns, {
    changedHigher: 0,
    controlHigher: 8,
    equal: 0,
  });
  assert.deepEqual(model.comparisons[1].cacheReadRatioDifferenceSigns, {
    changedHigher: 8,
    controlHigher: 0,
    equal: 0,
  });
});

test("marks zero-versus-directional endpoint disagreement indeterminate", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      request.scenario === "active-set-change"
    ) {
      request.cacheReadTokens = 100;
      request.inputTokens =
        request.variant === "unchanged-active-set" ? 200 : 100;
      request.totalTokens = request.inputTokens + 1;
    }
  }
  refreshModel(model);
  const result = await verify(evidence);
  const effect = result.report.effects.find(
    (item) =>
      item.scope === model.model && item.scenario === "active-set-change"
  );
  assert.equal(effect.conclusion, "endpoint-disagreement/indeterminate");
  assert.equal(
    effect.primary.endpoints.rawCacheReadTokens.conclusion,
    "no-observed-median-difference"
  );
  assert.equal(
    effect.primary.endpoints.cacheReadInputCoverageRatio.conclusion,
    "descriptive-changed-higher"
  );
});

test("uses exact rational median signs when float ratio deltas round to zero", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const input = 1_000_000_000_000_000;
  for (const request of model.requests) {
    if (request.phase !== "measure" || request.scenario !== "same-set-order") {
      continue;
    }
    const control = request.variant === "stable-order";
    request.inputTokens = control ? input : input - 1;
    request.cacheReadTokens = control ? input - 1 : input - 2;
    request.totalTokens = request.inputTokens;
  }
  refreshModel(model);
  const comparison = model.comparisons[0];
  assert.equal(comparison.medianControlMinusChangedCacheReadRatio, 0);
  assert.equal(comparison.medianControlMinusChangedCacheReadRatioSign, 1);
  assert.deepEqual(comparison.cacheReadRatioDifferenceSigns, {
    changedHigher: 0,
    controlHigher: 8,
    equal: 0,
  });
  const result = await verify(evidence);
  const effect = result.report.effects.find(
    (item) => item.scope === model.model && item.scenario === "same-set-order"
  );
  assert.equal(effect.conclusion, "descriptive-control-higher");
  assert.ok(
    effect.primary.endpoints.cacheReadInputCoverageRatio.orderStrata.every(
      (stratum) =>
        stratum.median === 0 && stratum.direction === "control-higher"
    )
  );
});

test("requires 4/4 coverage when one missing pair reverses a stratum median", async () => {
  const evidence = await copyPristine();
  const model = evidence.models[0];
  const targetOrder = "control-first";
  const targetTrials = trialsForOrder(
    model.model,
    "same-set-order",
    targetOrder
  );
  const targetDifferences = [-20, -10, 80, 90];
  const otherTrials = trialsForOrder(
    model.model,
    "same-set-order",
    "changed-first"
  );
  for (const request of model.requests) {
    if (request.phase !== "measure" || request.scenario !== "same-set-order") {
      continue;
    }
    const targetIndex = targetTrials.indexOf(request.trial);
    const otherIndex = otherTrials.indexOf(request.trial);
    const difference =
      targetIndex >= 0 ? targetDifferences[targetIndex] : 10 + otherIndex * 10;
    const control = request.variant === "stable-order";
    if (difference >= 0) {
      request.cacheReadTokens = control ? difference : 0;
    } else {
      request.cacheReadTokens = control ? 0 : -difference;
    }
    request.inputTokens = 100;
    request.totalTokens = 101;
  }
  const omittedTrial = targetTrials[3];
  for (const request of model.requests) {
    if (
      request.phase === "measure" &&
      request.scenario === "same-set-order" &&
      request.trial === omittedTrial
    ) {
      request.cacheReadSource = null;
      request.cacheReadTokens = null;
      request.usageFieldAudit.cacheRead = "absent";
    }
  }
  assert.equal((targetDifferences[1] + targetDifferences[2]) / 2, 35);
  assert.equal(targetDifferences[1], -10);
  refreshModel(model);
  const result = await verify(evidence);
  const effect = result.report.effects.find(
    (item) => item.scope === model.model && item.scenario === "same-set-order"
  );
  assert.equal(effect.conclusion, "insufficient-coverage");
  assert.equal(
    model.comparisons[0].effectConclusion,
    "indeterminate-insufficient-order-stratum-coverage"
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
  const evidence = {
    configuration,
    credentialRecorded: false,
    endpoint: "https://freerouter.minpeter.workers.dev/v1",
    generatedAt: requestTimestamp(EXPECTED_TOPOLOGY.totalRequests + 1),
    interpretation: MANUAL_INTERPRETATION,
    models,
    protocol: "openai-chat-completions",
    responseIdAudit: null,
    schemaVersion: 3,
  };
  refreshEvidence(evidence);
  return evidence;
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
    `${RUN_ID}\0${modelName}\0${scenario.name}\0${trial}\0${armIndex === 0 ? "first" : "second"}`
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
    serviceTierSha256: sha256("default"),
    serviceTierStatus: "hashed",
    settleElapsedMs: phase === "warmup" ? null : 1500,
    startedAt: requestTimestamp(requestSequence),
    success: true,
    systemFingerprintSha256: sha256("synthetic-backend-a"),
    systemFingerprintStatus: "hashed",
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

function refreshEvidence(evidence) {
  const allRequests = evidence.models.flatMap((model) => model.requests);
  const duplicateSets = responseIdDuplicateSets(allRequests);
  for (const model of evidence.models) {
    Object.assign(model, deriveModelViews(model.requests, duplicateSets));
  }
  evidence.responseIdAudit = deriveResponseIdAudit(allRequests);
}

async function syntheticConfiguration() {
  const workingTreeCommit = execFileSync(
    "git",
    ["stash", "create", "synthetic cache verifier source freeze"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  ).trim();
  const sourceFreezeCommitSha =
    workingTreeCommit ||
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim();
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
    backendMetadataSemantics: MANUAL_METHODOLOGY.backendMetadataSemantics,
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
    minimumOrderStratumCoverage: 1,
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
    responseBodyLimits: {
      chatCompletionsBytes: 1_000_000,
      modelCatalogBytes: 5_000_000,
    },
    runId: RUN_ID,
    seed: EXPECTED_CAMPAIGN_ID,
    settleMs: 1500,
    sourceFreezeCommitSha,
    sourceSnapshotSemantics: MANUAL_METHODOLOGY.sourceSnapshotSemantics,
    sourceWorktreeCleanAtStart: true,
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
