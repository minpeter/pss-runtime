import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  aggregateConfirmationRuns,
  evaluateConfirmationConclusion,
  evaluateRouteGuardrails,
  verifyConfirmationCampaign,
  verifyResponseAttribution,
} from "./cache-confirmation-evidence.mjs";

const ATTRIBUTION_FLAG_PATTERN = /responseModelMatchesRequested/u;

describe("confirmation response-model verification", () => {
  it("keeps a successful mismatched model as auditable evidence", () => {
    assert.doesNotThrow(() =>
      verifyResponseAttribution(
        successfulTurn("provider/alias", false),
        "provider/requested"
      )
    );
  });

  it("keeps a successful missing model as auditable evidence", () => {
    assert.doesNotThrow(() =>
      verifyResponseAttribution(
        successfulTurn(null, null),
        "provider/requested"
      )
    );
  });

  it("rejects attribution flags that disagree with the response model", () => {
    assert.throws(
      () =>
        verifyResponseAttribution(
          successfulTurn("provider/alias", true),
          "provider/requested"
        ),
      ATTRIBUTION_FLAG_PATTERN
    );
  });

  it("excludes mismatched and missing models only from cache attribution", () => {
    const requestedModel = "provider/requested";
    const turns = [
      aggregateTurn(0, requestedModel, true, 0, 100),
      aggregateTurn(1, requestedModel, true, 80, 100),
      aggregateTurn(2, "provider/alias", false, 90, 100),
      aggregateTurn(3, null, null, 100, 100),
    ];

    const aggregate = aggregateConfirmationRuns([{ turns }]);
    assert.equal(aggregate.cacheAttributionEligibleWarmRequests, 1);
    assert.equal(aggregate.cacheHitRate, 0.8);
    assert.deepEqual(aggregate.responseModelAudit, {
      exactRequestedModel: 2,
      mismatched: 1,
      missingOrInvalid: 1,
      turns: 4,
    });
    assert.equal(aggregate.successfulTurns, 4);
    assert.equal(aggregate.telemetryCoverage, 1);
    assert.equal(aggregate.trackedCacheReadTokens, 80);
    assert.equal(aggregate.trackedInputTokens, 100);
    assert.equal(aggregate.trackedRequests, 1);
  });

  it("verifies a full campaign without turning attribution misses into request failures", () => {
    const campaign = confirmationCampaign();
    campaign.runs[0].turns[1].responseModel = "provider/alias";
    campaign.runs[0].turns[1].responseModelMatchesRequested = false;
    refreshRun(campaign.runs[0], campaign.runs[0].modelId);
    campaign.runs[1].turns[1].responseModel = null;
    campaign.runs[1].turns[1].responseModelMatchesRequested = null;
    refreshRun(campaign.runs[1], campaign.runs[1].modelId);

    assert.doesNotThrow(() =>
      verifyConfirmationCampaign(campaign, {
        label: "synthetic campaign",
        verifyCurrentProvenance: false,
      })
    );
    assert.equal(campaign.runs[0].failures, 0);
    assert.equal(campaign.runs[0].cacheAttributionEligibleWarmRequests, 4);
    assert.equal(campaign.runs[1].failures, 0);
    assert.equal(campaign.runs[1].cacheAttributionEligibleWarmRequests, 4);
  });

  it("does not let a pooled route hide another route's regression", () => {
    const campaign = confirmationCampaign();
    const summaries = armSummary(campaign.runs);
    const byScenario = {
      conversation: {
        "route-aware": {
          ...summaries["route-aware"],
          p95LatencyMs: summaries.uniform.p95LatencyMs + 1,
        },
        uniform: summaries.uniform,
      },
      "file-search": summaries,
    };
    const guardrails = evaluateRouteGuardrails(byScenario);

    assert.equal(guardrails["file-search"].status, "pass");
    assert.equal(guardrails.conversation.status, "fail");
    assert.deepEqual(guardrails.conversation.failedGuardrails, [
      "p95-latency-regression",
    ]);
    assert.equal(evaluateConfirmationConclusion(guardrails).status, "fail");
  });

  it("treats an unknown successful finish reason as indeterminate", () => {
    const campaign = confirmationCampaign();
    campaign.runs[0].turns[1].finishReason = null;
    refreshRun(campaign.runs[0], campaign.runs[0].modelId);
    const guardrails = evaluateRouteGuardrails({
      conversation: armSummary(confirmationCampaign().runs),
      "file-search": armSummary(campaign.runs),
    });

    assert.equal(guardrails["file-search"].status, "indeterminate");
    assert.deepEqual(guardrails["file-search"].indeterminateReasons, [
      "uniform:finish-reason-incomplete",
    ]);
    assert.equal(
      evaluateConfirmationConclusion(guardrails).status,
      "indeterminate"
    );
  });
});

function successfulTurn(responseModel, responseModelMatchesRequested) {
  return {
    errorClass: null,
    httpStatus: 200,
    requestSuccessful: true,
    responseModel,
    responseModelMatchesRequested,
  };
}

function aggregateTurn(
  step,
  responseModel,
  responseModelMatchesRequested,
  cachedTokens,
  inputTokens
) {
  return {
    attempts: 1,
    cacheWriteTokens: null,
    cachedTokens,
    correct: true,
    inputTokens,
    latencyMs: 10,
    requestSuccessful: true,
    responseModel,
    responseModelMatchesRequested,
    step,
    tokenRecallCorrect: true,
    usageEnvelopeValid: true,
  };
}

function confirmationCampaign() {
  const modelId = "mistralai/ministral-14b-latest";
  const files = [{ path: "synthetic.mjs", sha256: sha256("source") }];
  return {
    benchmarkSource: {
      files,
      manifestSha256: sha256(JSON.stringify(files)),
    },
    campaignCompletedAt: "2026-07-17T01:01:00.000Z",
    campaignStartedAt: "2026-07-17T01:00:00.000Z",
    checkedInContent: {
      modelOutputs: false,
      perTurnTelemetry: true,
      prompts: false,
      rawBodies: false,
    },
    config: {
      confirmationMode: true,
      confirmationOrder: ["uniform", "route-aware", "route-aware", "uniform"],
      correctness: {
        strict:
          "Trimmed response must parse as one JSON object with exactly the requested keys and exact values.",
        tokenRecallProxy:
          "Legacy expected-token containment is retained as a separate recall proxy and never substitutes for strict correctness.",
      },
      highWaterTokens: 75_000,
      maximumHttpAttemptsPerTurn: 1,
      models: [
        {
          contextLength: 262_144,
          id: modelId,
          maxOutputTokens: 160,
        },
      ],
      steps: 6,
      targetChunkCharacters: 60_000,
    },
    credentialRecorded: false,
    endpoint: "https://freerouter.minpeter.workers.dev/v1",
    fixture: {
      chunks: Array.from({ length: 6 }, (_, step) => ({
        characters: 60_000,
        expectedTokenCount: 1,
        step,
      })),
      fixtureSha256: sha256("fixture"),
      highWaterTokens: 75_000,
      scenario: "file-search",
      schemaVersion: 1,
      steps: 6,
      targetChunkCharacters: 60_000,
    },
    modelCatalog: {
      available: true,
      checkedAt: "2026-07-17T01:00:00.000Z",
      httpStatus: 200,
      presentModelIds: [modelId],
      requestedModelIds: [modelId],
      status: "passed",
    },
    runs: ["uniform", "route-aware", "route-aware", "uniform"].map(
      (arm, index) => confirmationRun(arm, index, modelId)
    ),
    scenario: "file-search",
    schemaVersion: 2,
  };
}

function confirmationRun(arm, index, modelId) {
  const run = {
    arm,
    cacheIsolationKeySha256: sha256(`isolation-${index}`),
    compactionTriggers: [],
    compactions: 0,
    highWaterTokens: arm === "uniform" ? 60_000 : 75_000,
    maxOutputTokens: 160,
    modelId,
    orderIndex: index,
    policy: "high-water-stable-prefix",
    replicate: index < 2 ? 1 : 2,
    turns: Array.from({ length: 6 }, (_, step) =>
      confirmationTurn(step, modelId)
    ),
  };
  refreshRun(run, modelId);
  return run;
}

function confirmationTurn(step, modelId) {
  return {
    attempts: 1,
    cacheFieldReported: true,
    cachedTokens: step === 0 ? 0 : 80,
    cacheWriteFieldReported: false,
    cacheWriteTokens: null,
    correct: true,
    errorClass: null,
    finishReason: "stop",
    httpStatus: 200,
    inputTokens: 100,
    latencyMs: 10,
    requestSuccessful: true,
    responseModel: modelId,
    responseModelMatchesRequested: true,
    step,
    tokenRecallCorrect: true,
    usageEnvelopeValid: true,
    usageFieldAudit: {
      cacheRead: "valid",
      cacheWrite: "absent",
      input: "valid",
    },
  };
}

function refreshRun(run, modelId) {
  const aggregate = aggregateConfirmationRuns([run]);
  Object.assign(run, {
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
    responseModelAudit: responseAudit(run.turns, modelId),
    telemetryCoverage: aggregate.telemetryCoverage,
    tokenRecallRate: aggregate.tokenRecallRate,
    trackedCacheReadTokens: aggregate.trackedCacheReadTokens,
    trackedCacheWriteTokens: aggregate.trackedCacheWriteTokens,
    trackedInputTokens: aggregate.trackedInputTokens,
    trackedRequests: aggregate.trackedRequests,
  });
}

function responseAudit(turns, requestedModel) {
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function armSummary(runs) {
  return Object.fromEntries(
    ["uniform", "route-aware"].map((arm) => [
      arm,
      aggregateConfirmationRuns(runs.filter((run) => run.arm === arm)),
    ])
  );
}
