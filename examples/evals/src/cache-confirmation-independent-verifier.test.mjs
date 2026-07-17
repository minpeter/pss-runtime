import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  deriveIndependentConfirmationFields,
  recomputeIndependentRunFields,
  renderIndependentConfirmationMarkdown,
  STRICT_CORRECTNESS_VERIFICATION_LIMIT,
  verifyIndependentConfirmationArtifacts,
  verifyIndependentConfirmationDocument,
} from "./cache-confirmation-independent-verifier.mjs";

const confirmationSnapshotUrl = new URL(
  "../evidence/cache-telemetry/2026-07-17-route-aware-confirmation.json",
  import.meta.url
);
const verifierSourceUrl = new URL(
  "./cache-confirmation-independent-verifier.mjs",
  import.meta.url
);
const LIMITATION_PATTERN = /cannot independently re-grade/u;
const CREDENTIAL_PATTERN = /credential-like string/u;
const USAGE_ENVELOPE_PATTERN = /usageEnvelopeValid/u;
const TRACKED_INPUT_PATTERN = /trackedInputTokens/u;
const CAMPAIGN_HASH_PATTERN = /campaign canonical hashes/u;
const MANIFEST_HASH_PATTERN = /manifestSha256/u;
const GUARDRAIL_PATTERN = /route guardrail decisions/u;
const MARKDOWN_PATTERN = /independently regenerated document/u;
const FIXTURE_PATTERN = /independently pinned deterministic fixture/u;
const DATA_PROPERTY_PATTERN = /own data property/u;
const DENSE_PATTERN = /dense/u;
const PROXY_PATTERN = /must not be a Proxy/u;
const ARRAY_BOUND_PATTERN = /length must be at most/u;
const STATIC_IMPORT_DECLARATION_PATTERN = /^\s*import(?!\s*\()[\s\S]*?;\s*$/gmu;
const IMPORT_FROM_SPECIFIER_PATTERN = /\bfrom\s+["']([^"']+)["']/u;
const IMPORT_SIDE_EFFECT_SPECIFIER_PATTERN = /^\s*import\s+["']([^"']+)["']/u;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/u;
const EXPECTED_VERIFIER_IMPORTS = [
  "node:assert/strict",
  "node:crypto",
  "node:fs",
  "node:path",
  "node:url",
  "node:util",
];
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

describe("independent confirmation verifier", () => {
  it("recomputes the sanitized snapshot without importing producer logic", () => {
    const document = confirmationDocument();
    const result = verifyIndependentConfirmationDocument(document);
    const markdown = renderIndependentConfirmationMarkdown(document);

    assert.equal(result.campaignsVerified, 2);
    assert.equal(result.logicalTurnsVerified, 48);
    assert.equal(result.sourceManifestsVerified, true);
    assert.deepEqual(result.strictCorrectnessVerification, {
      aggregateAndGuardrailRecomputedFromRecordedBooleans: true,
      independentlyRegradedFromModelOutputs: false,
      limitation: STRICT_CORRECTNESS_VERIFICATION_LIMIT,
      modelOutputsPresent: false,
    });
    assert.match(markdown, LIMITATION_PATTERN);
    assert.doesNotThrow(() =>
      verifyIndependentConfirmationArtifacts({
        document,
        markdown,
      })
    );
  });

  it("rejects a credential-like string even in an otherwise allowed field", () => {
    const document = confirmationDocument();
    document.confirmationConclusion.reason = [
      "Bearer",
      "synthetic-secret-token",
    ].join(" ");

    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(document, {
          verifyCurrentSources: false,
        }),
      CREDENTIAL_PATTERN
    );
  });

  it("rejects a contradictory per-turn usage envelope", () => {
    const document = confirmationDocument();
    const turn = document.campaigns["file-search"].runs[0].turns[1];
    turn.cachedTokens = turn.inputTokens + 1;

    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(document, {
          verifyCurrentSources: false,
        }),
      USAGE_ENVELOPE_PATTERN
    );
  });

  it("rejects a recorded run aggregate that does not match raw turns", () => {
    const document = confirmationDocument();
    document.campaigns.conversation.runs[0].trackedInputTokens += 1;

    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(document, {
          verifyCurrentSources: false,
        }),
      TRACKED_INPUT_PATTERN
    );
  });

  it("rejects campaign-hash and source-manifest tampering", () => {
    const hashTampered = confirmationDocument();
    hashTampered.campaignCanonicalSha256.conversation = "0".repeat(64);
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(hashTampered, {
          verifyCurrentSources: false,
        }),
      CAMPAIGN_HASH_PATTERN
    );

    const manifestTampered = confirmationDocument();
    manifestTampered.evidenceToolSource.files[0].sha256 = "0".repeat(64);
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(manifestTampered, {
          verifyCurrentSources: false,
        }),
      MANIFEST_HASH_PATTERN
    );
  });

  it("binds fixture hashes and chunk metadata to pinned deterministic fixtures", () => {
    const hashTampered = confirmationDocument();
    hashTampered.campaigns.conversation.fixture.fixtureSha256 = "0".repeat(64);
    refreshDocument(hashTampered);
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(hashTampered, {
          verifyCurrentSources: false,
        }),
      FIXTURE_PATTERN
    );

    const chunkTampered = confirmationDocument();
    chunkTampered.campaigns["file-search"].fixture.chunks[0].characters += 1;
    refreshDocument(chunkTampered);
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(chunkTampered, {
          verifyCurrentSources: false,
        }),
      FIXTURE_PATTERN
    );
  });

  it("rejects accessors and sparse arrays without invoking an accessor", () => {
    const accessorDocument = confirmationDocument();
    let getterCalls = 0;
    Object.defineProperty(accessorDocument, "schemaVersion", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(accessorDocument, {
          verifyCurrentSources: false,
        }),
      DATA_PROPERTY_PATTERN
    );
    assert.equal(getterCalls, 0);

    const sparseDocument = confirmationDocument();
    Reflect.deleteProperty(sparseDocument.campaigns.conversation.runs, "0");
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(sparseDocument, {
          verifyCurrentSources: false,
        }),
      DENSE_PATTERN
    );
  });

  it("rejects proxies and oversized arrays before traps or allocation", () => {
    let prototypeTrapCalls = 0;
    const proxyDocument = new Proxy(confirmationDocument(), {
      getPrototypeOf() {
        prototypeTrapCalls += 1;
        throw new Error("prototype trap must stay inert");
      },
    });
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(proxyDocument, {
          verifyCurrentSources: false,
        }),
      PROXY_PATTERN
    );
    assert.equal(prototypeTrapCalls, 0);

    const oversizedDocument = confirmationDocument();
    oversizedDocument.campaigns.conversation.runs = new Array(10_001);
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(oversizedDocument, {
          verifyCurrentSources: false,
        }),
      ARRAY_BOUND_PATTERN
    );
  });

  it("imports only Node standard-library modules", () => {
    const source = readFileSync(verifierSourceUrl, "utf8");
    const specifiers = staticImportSpecifiers(source);

    assert.deepEqual(specifiers, EXPECTED_VERIFIER_IMPORTS);
    assert.doesNotMatch(source, DYNAMIC_IMPORT_PATTERN);
  });

  it("recognizes multiline and side-effect static imports", () => {
    const source = [
      'import "./producer-side-effect.mjs";',
      "import {",
      "  producer,",
      '} from "./producer.mjs";',
      'import assert from "node:assert/strict";',
    ].join("\n");

    assert.deepEqual(staticImportSpecifiers(source), [
      "./producer-side-effect.mjs",
      "./producer.mjs",
      "node:assert/strict",
    ]);
  });

  it("detects equal-sized telemetry samples at different replicate-step coordinates", () => {
    const document = coordinateMismatchDocument();
    const fileSearch = document.byScenario["file-search"];
    const result = document.routeGuardrails["file-search"];

    assert.equal(
      fileSearch.uniform.trackedRequests,
      fileSearch["route-aware"].trackedRequests
    );
    assert.notDeepEqual(
      fileSearch.uniform.trackedWarmCoordinates,
      fileSearch["route-aware"].trackedWarmCoordinates
    );
    assert.equal(result.status, "indeterminate");
    assert.ok(
      result.indeterminateReasons.includes("arms:tracked-coordinate-mismatch")
    );
    assert.doesNotThrow(() =>
      verifyIndependentConfirmationDocument(document, {
        verifyCurrentSources: false,
      })
    );

    result.status = "pass";
    result.indeterminateReasons = [];
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(document, {
          verifyCurrentSources: false,
        }),
      GUARDRAIL_PATTERN
    );
  });

  it("gives an observed correctness failure precedence over indeterminate telemetry", () => {
    const document = coordinateMismatchDocument();
    const routeAwareRun = document.campaigns["file-search"].runs[1];
    routeAwareRun.turns[3].correct = false;
    refreshRun(routeAwareRun);
    refreshDocument(document);

    const result = document.routeGuardrails["file-search"];
    assert.equal(result.status, "fail");
    assert.ok(result.failedGuardrails.includes("perfect-strict-correctness"));
    assert.ok(result.indeterminateReasons.length > 0);
    assert.doesNotThrow(() =>
      verifyIndependentConfirmationDocument(document, {
        verifyCurrentSources: false,
      })
    );

    result.status = "indeterminate";
    assert.throws(
      () =>
        verifyIndependentConfirmationDocument(document, {
          verifyCurrentSources: false,
        }),
      GUARDRAIL_PATTERN
    );
  });

  it("rejects Markdown that was not regenerated from the verified JSON", () => {
    const document = confirmationDocument();
    const markdown = renderIndependentConfirmationMarkdown(document, {
      verifyCurrentSources: false,
    });

    assert.throws(
      () =>
        verifyIndependentConfirmationArtifacts({
          document,
          markdown: `${markdown}\nmutated\n`,
          verifyCurrentSources: false,
        }),
      MARKDOWN_PATTERN
    );
  });
});

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

function confirmationDocument() {
  const document = JSON.parse(readFileSync(confirmationSnapshotUrl, "utf8"));
  const benchmarkSource = sourceManifest(BENCHMARK_SOURCE_PATHS);
  for (const campaign of Object.values(document.campaigns)) {
    campaign.benchmarkSource = structuredClone(benchmarkSource);
  }
  document.evidenceToolSource = sourceManifest(EVIDENCE_SOURCE_PATHS);
  document.confirmationDesign.guardrails.requireIdenticalTrackedCoordinates = true;
  for (const campaign of Object.values(document.campaigns)) {
    for (const run of campaign.runs) {
      let changed = false;
      for (const turn of run.turns) {
        if (turn.requestSuccessful && turn.finishReason !== "stop") {
          turn.correct = false;
          turn.errorClass = "non-stop-finish-reason";
          turn.requestSuccessful = false;
          turn.tokenRecallCorrect = false;
          changed = true;
        }
      }
      if (changed) {
        refreshRun(run);
      }
    }
  }
  refreshDocument(document);
  return document;
}

function coordinateMismatchDocument() {
  const document = confirmationDocument();
  const campaign = document.campaigns["file-search"];
  for (const run of campaign.runs) {
    for (const turn of run.turns) {
      Object.assign(turn, {
        cacheFieldReported: true,
        cachedTokens: 500,
        cacheWriteFieldReported: false,
        cacheWriteTokens: null,
        correct: true,
        errorClass: null,
        finishReason: "stop",
        httpStatus: 200,
        inputTokens: 1000,
        latencyMs: 100,
        requestSuccessful: true,
        responseModel: run.modelId,
        responseModelMatchesRequested: true,
        tokenRecallCorrect: true,
        usageEnvelopeValid: true,
        usageFieldAudit: {
          cacheRead: "valid",
          cacheWrite: "absent",
          input: "valid",
        },
      });
    }
    refreshRun(run);
  }
  omitCacheRead(campaign.runs[0].turns[1]);
  omitCacheRead(campaign.runs[1].turns[2]);
  refreshRun(campaign.runs[0]);
  refreshRun(campaign.runs[1]);
  refreshDocument(document);
  return document;
}

function omitCacheRead(turn) {
  turn.cacheFieldReported = false;
  turn.cachedTokens = null;
  turn.usageFieldAudit.cacheRead = "absent";
}

function refreshRun(run) {
  Object.assign(run, recomputeIndependentRunFields(run));
}

function refreshDocument(document) {
  Object.assign(document, deriveIndependentConfirmationFields(document));
}

function sourceManifest(paths) {
  const files = paths.map((path) => ({
    path,
    sha256: sha256(readFileSync(new URL(`./${path}`, import.meta.url))),
  }));
  return { files, manifestSha256: sha256(JSON.stringify(files)) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
