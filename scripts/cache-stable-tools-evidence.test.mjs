import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_ZERO_TOOL_FINISH_REASONS,
  ARM_EXECUTION_PHASES,
  benchmarkRequestArtifacts,
  DYNAMIC_TOOL_NAMES,
  EVIDENCE_CAMPAIGN,
  EVIDENCE_CAMPAIGN_TOPOLOGY,
  FINISH_REASON_STATUSES,
  FIXED_TOOL_NAMES,
  IMPLEMENTATION_SOURCE_PATHS,
  isolationTokenFor,
  MEMBERSHIP_REPLACEMENT_TOOL_NAME,
  pairOrderFor,
} from "./benchmark-cache-stable-tools.mts";

const EVIDENCE_URL = new URL(
  "../benchmarks/cache-stable-tools/latest-freerouter.json",
  import.meta.url
);
const PROBE_URL = new URL(
  "../benchmarks/cache-stable-tools/mistral-response-shape-probe.json",
  import.meta.url
);
const RUNNER_URL = new URL(
  "./benchmark-cache-stable-tools.mts",
  import.meta.url
);
const IMPLEMENTATION_SOURCE_URLS = Object.fromEntries(
  IMPLEMENTATION_SOURCE_PATHS.map((path) => [
    path,
    new URL(`../${path}`, import.meta.url),
  ])
);
const EXPECTED_ENDPOINT = EVIDENCE_CAMPAIGN.baseUrl;
const EXPECTED_MODELS = EVIDENCE_CAMPAIGN.models;
const SCENARIO_VARIANTS = Object.fromEntries(
  EVIDENCE_CAMPAIGN.scenarios.map((scenario) => [
    scenario.name,
    [scenario.controlVariant, scenario.changedVariant],
  ])
);
const SCENARIOS = Object.keys(SCENARIO_VARIANTS);
const EXPECTED_TRIALS = EVIDENCE_CAMPAIGN.trials;
const VARIANTS_PER_SCENARIO = EVIDENCE_CAMPAIGN.scenarios[0].arms.length;
const PHASES_PER_ARM = EVIDENCE_CAMPAIGN_TOPOLOGY.phasesPerArm;
const PAIR_ORDERS = EVIDENCE_CAMPAIGN_TOPOLOGY.pairOrderCount;
const PAIR_ORDER_VALUES = ["control-first", "changed-first"];
const TRIAL_NUMBERS = Array.from(
  { length: EXPECTED_TRIALS },
  (_, index) => index + 1
);
const ARMS_PER_MODEL = EVIDENCE_CAMPAIGN_TOPOLOGY.armsPerModel;
const REQUESTS_PER_MODEL = EVIDENCE_CAMPAIGN_TOPOLOGY.requestsPerModel;
const MIN_STRATUM_COVERAGE = EVIDENCE_CAMPAIGN.minimumStratumCoverage;
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
const USAGE_STATUSES = ["absent", "valid", "invalid", "conflict"];
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[\w.-]{1,80}$/u;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BEARER_PATTERN = /Bearer\s/iu;
const KEY_LIKE_PATTERN = /\bfr-[\w-]{8,}\b/u;
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/u;
const FORBIDDEN_RESULT_KEYS = new Set([
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
const REQUEST_KEYS = [
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
];

describe("checked-in cache-stable tool evidence", () => {
  it("independently verifies the sanitized three-scenario live snapshot", async () => {
    const [serialized, runnerSource, implementationSources] = await Promise.all(
      [
        readFile(EVIDENCE_URL, "utf8"),
        readFile(RUNNER_URL),
        Promise.all(
          Object.entries(IMPLEMENTATION_SOURCE_URLS).map(
            async ([path, url]) => [path, await readFile(url)]
          )
        ),
      ]
    );
    const evidence = JSON.parse(serialized);

    expectExactKeys(evidence, [
      "configuration",
      "credentialRecorded",
      "endpoint",
      "generatedAt",
      "interpretation",
      "models",
      "protocol",
      "schemaVersion",
    ]);
    expect(evidence).toMatchObject({
      credentialRecorded: false,
      endpoint: EXPECTED_ENDPOINT,
      protocol: "openai-chat-completions",
      schemaVersion: 3,
    });
    expectValidTimestamp(evidence.generatedAt);
    verifyConfiguration(
      evidence.configuration,
      runnerSource,
      Object.fromEntries(implementationSources)
    );
    expectExactKeys(evidence.interpretation, [
      "not-reported",
      "reported-nonzero",
      "reported-zero-only",
      "unavailable",
    ]);
    expect(evidence.models.map(({ model }) => model)).toEqual(EXPECTED_MODELS);

    const allRequests = evidence.models.flatMap((entry) => entry.requests);
    expect(allRequests).toHaveLength(EVIDENCE_CAMPAIGN_TOPOLOGY.totalRequests);
    expect(allRequests.map(({ requestSequence }) => requestSequence)).toEqual(
      Array.from({ length: allRequests.length }, (_, index) => index + 1)
    );
    expect(
      new Set(
        allRequests.map(({ isolationCanarySha256 }) => isolationCanarySha256)
      ).size
    ).toBe(EXPECTED_MODELS.length * ARMS_PER_MODEL);

    for (const model of evidence.models) {
      verifyModel(model, evidence.configuration);
    }
    verifyCounterbalance(evidence);
    expect(findForbiddenKeys(evidence)).toEqual([]);
    expect(serialized).not.toMatch(BEARER_PATTERN);
    expect(serialized).not.toMatch(KEY_LIKE_PATTERN);
  });

  it("keeps the parser-discovery probe shape-only and credential-free", async () => {
    const serialized = await readFile(PROBE_URL, "utf8");
    const probe = JSON.parse(serialized);
    expectExactKeys(probe, [
      "credentialRecorded",
      "endpoint",
      "generatedAt",
      "httpStatus",
      "httpSuccess",
      "protocol",
      "requestedModel",
      "responseShape",
      "schemaVersion",
    ]);
    expect(probe).toMatchObject({
      credentialRecorded: false,
      endpoint: EXPECTED_ENDPOINT,
      httpStatus: 200,
      httpSuccess: true,
      protocol: "openai-chat-completions",
      requestedModel: "mistralai/ministral-14b-latest",
      schemaVersion: 1,
      responseShape: {
        choices: { kind: "array", length: 1, present: true },
        content: { exactTrimmedOk: true, kind: "string", present: true },
        firstChoiceKind: "object",
        functionCall: { kind: "undefined", present: false },
        message: { kind: "object", present: true },
        model: { matchesRequested: true, safeIdReported: true },
        rootKind: "object",
        toolCalls: { kind: "null", length: null, present: true },
        usage: { kind: "object", present: true },
      },
    });
    expectValidTimestamp(probe.generatedAt);
    expectExactKeys(probe.responseShape, [
      "choices",
      "content",
      "firstChoiceKind",
      "functionCall",
      "message",
      "model",
      "rootKind",
      "toolCalls",
      "usage",
    ]);
    expectExactKeys(probe.responseShape.choices, ["kind", "length", "present"]);
    expectExactKeys(probe.responseShape.content, [
      "exactTrimmedOk",
      "kind",
      "present",
    ]);
    expectExactKeys(probe.responseShape.functionCall, ["kind", "present"]);
    expectExactKeys(probe.responseShape.message, ["kind", "present"]);
    expectExactKeys(probe.responseShape.model, [
      "matchesRequested",
      "safeIdReported",
    ]);
    expectExactKeys(probe.responseShape.toolCalls, [
      "kind",
      "length",
      "present",
    ]);
    expectExactKeys(probe.responseShape.usage, ["kind", "present"]);
    expect(findForbiddenKeys(probe)).toEqual(["result.responseShape.content"]);
    expect(serialized).not.toMatch(BEARER_PATTERN);
    expect(serialized).not.toMatch(KEY_LIKE_PATTERN);
  });
});

function verifyConfiguration(
  configuration,
  runnerSource,
  implementationSources
) {
  expectExactKeys(configuration, [
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
  ]);
  expect(configuration.models).toEqual(EXPECTED_MODELS);
  expect(configuration.trials).toBe(EXPECTED_TRIALS);
  expect(configuration.campaignId).toBe(EVIDENCE_CAMPAIGN.id);
  expect(configuration.prefixLines).toBe(EVIDENCE_CAMPAIGN.prefixLines);
  expect(configuration.maxOutputTokens).toBe(256);
  expect(configuration.seed).toBe(EVIDENCE_CAMPAIGN.seed);
  expect(configuration.settleMs).toBe(EVIDENCE_CAMPAIGN.settleMs);
  expect(configuration.timeoutMs).toBe(EVIDENCE_CAMPAIGN.timeoutMs);
  expect(configuration.minimumOrderStratumCoverage).toBe(MIN_STRATUM_COVERAGE);
  expect(configuration.effectConclusionPolicy).toBeTypeOf("string");
  expect(configuration.fixedToolNames).toEqual(FIXED_TOOL_NAMES);
  expect(configuration.dynamicToolNames).toEqual(DYNAMIC_TOOL_NAMES);
  expect(configuration.membershipReplacementToolName).toBe(
    MEMBERSHIP_REPLACEMENT_TOOL_NAME
  );
  expect(configuration.requestTopology).toEqual(EVIDENCE_CAMPAIGN_TOPOLOGY);
  expect(configuration.runId).toMatch(UUID_PATTERN);
  expect(configuration.nodeVersion).toMatch(NODE_VERSION_PATTERN);
  expect(configuration.benchmarkSourceSha256).toMatch(HASH_PATTERN);
  expect(configuration.benchmarkSourceSha256).toBe(sha256(runnerSource));
  expectExactKeys(
    configuration.implementationSourcesSha256,
    Object.keys(IMPLEMENTATION_SOURCE_URLS)
  );
  for (const [path, source] of Object.entries(implementationSources)) {
    expect(configuration.implementationSourcesSha256[path]).toMatch(
      HASH_PATTERN
    );
    expect(configuration.implementationSourcesSha256[path]).toBe(
      sha256(source)
    );
  }
  expect(configuration.armExecutionOrder).toMatchObject({
    mode: "seeded-alternating-ab-ba",
    models: EXPECTED_MODELS,
    scenarios: SCENARIOS,
  });
  expectExactKeys(configuration.armExecutionOrder, [
    "algorithm",
    "mode",
    "models",
    "orderAssignments",
    "phasesPerArm",
    "scenarios",
    "variantsByScenario",
  ]);
  expectExactKeys(
    configuration.armExecutionOrder.variantsByScenario,
    SCENARIOS
  );
  expect(configuration.armExecutionOrder.variantsByScenario).toEqual(
    SCENARIO_VARIANTS
  );
  expect(configuration.armExecutionOrder.phasesPerArm).toEqual(
    ARM_EXECUTION_PHASES
  );
  for (const assignment of configuration.armExecutionOrder.orderAssignments) {
    expectExactKeys(assignment, [
      "model",
      "pairOrder",
      "scenario",
      "trial",
      "variants",
    ]);
  }
  expect(configuration.armExecutionOrder.orderAssignments).toHaveLength(
    EVIDENCE_CAMPAIGN_TOPOLOGY.orderAssignmentCount
  );
  expect(configuration.modelPreflight).toMatchObject({
    presentModelIds: EXPECTED_MODELS,
    requestedModelIds: EXPECTED_MODELS,
    status: "passed",
  });
  expectExactKeys(configuration.modelPreflight, [
    "checkedAt",
    "presentModelIds",
    "requestedModelIds",
    "status",
  ]);
  expectExactKeys(configuration.armIsolation, ["canary", "promptNamespace"]);
  expectExactKeys(configuration.comparisonSemantics, SCENARIOS);
  expectExactKeys(configuration.eligibilitySemantics, [
    "cacheTelemetryEligible",
    "captureSuccess",
  ]);
  expectExactKeys(configuration.finishReasonValidation, [
    "acceptedZeroToolReasons",
    "policy",
    "statuses",
  ]);
  expect(configuration.finishReasonValidation.acceptedZeroToolReasons).toEqual(
    ACCEPTED_ZERO_TOOL_FINISH_REASONS
  );
  expect(configuration.finishReasonValidation.statuses).toEqual(
    FINISH_REASON_STATUSES
  );
  expect(configuration.finishReasonValidation.policy).toBeTypeOf("string");
  expectValidTimestamp(configuration.modelPreflight.checkedAt);
}

function verifyModel(model, configuration) {
  expectExactKeys(model, [
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
  expect(EXPECTED_MODELS).toContain(model.model);
  expect(model.requests).toHaveLength(REQUESTS_PER_MODEL);
  expect(model.requests.filter(({ phase }) => phase === "warmup")).toHaveLength(
    ARMS_PER_MODEL
  );
  expect(
    model.requests.filter(({ phase }) => phase === "measure")
  ).toHaveLength(ARMS_PER_MODEL);
  for (const request of model.requests) {
    verifyRequest(request, model.model, configuration);
  }
  verifyMeasurementPrerequisites(model);
  for (const scenario of SCENARIOS) {
    const scenarioRequests = model.requests.filter(
      (request) => request.scenario === scenario
    );
    const requestsPerScenario =
      EVIDENCE_CAMPAIGN_TOPOLOGY.requestsPerScenario[scenario];
    expect(requestsPerScenario).toBeTypeOf("number");
    expect(scenarioRequests).toHaveLength(requestsPerScenario);
    const requestsPerOrderStratum = requestsPerScenario / PAIR_ORDERS;
    const measurementsPerOrderStratum =
      requestsPerOrderStratum / PHASES_PER_ARM;
    for (const order of ["control-first", "changed-first"]) {
      const stratum = scenarioRequests.filter(
        (request) => request.pairOrder === order
      );
      const measured = stratum.filter(({ phase }) => phase === "measure");
      expect(stratum).toHaveLength(requestsPerOrderStratum);
      expect(measured).toHaveLength(measurementsPerOrderStratum);
      expect(
        stratum.filter(({ success }) => success).length
      ).toBeGreaterThanOrEqual(requestsPerOrderStratum * MIN_STRATUM_COVERAGE);
      expect(
        stratum.filter(({ cacheTelemetryEligible }) => cacheTelemetryEligible)
          .length
      ).toBeGreaterThanOrEqual(requestsPerOrderStratum * MIN_STRATUM_COVERAGE);
      expect(
        measured.filter(({ success }) => success).length
      ).toBeGreaterThanOrEqual(
        measurementsPerOrderStratum * MIN_STRATUM_COVERAGE
      );
      expect(
        measured.filter(({ cacheTelemetryEligible }) => cacheTelemetryEligible)
          .length
      ).toBeGreaterThanOrEqual(
        measurementsPerOrderStratum * MIN_STRATUM_COVERAGE
      );
    }
  }
  verifyIsolation(model);
  verifyMembershipInputTokenParity(model);
  verifyRequestOutcomes(model);
  verifyFinishReasonAudit(model);
  verifyResponseModelAudit(model);
  verifyOutputCompliance(model);
  verifyUsageFieldStatusAudit(model);
  verifyComparisons(model);
  verifySummaries(model);
  expect(model.cacheReporting).toBe(reportingStatus(model.requests));
  expect(model.cacheWriteReporting).toBe(
    cacheWriteReportingStatus(model.requests)
  );
}

function verifyRequest(request, requestedModel, configuration) {
  expectExactKeys(request, REQUEST_KEYS);
  expectExactKeys(request.usageFieldAudit, [
    "cacheRead",
    "cacheWrite",
    "input",
    "output",
    "total",
  ]);
  expect(request.requestBodySha256).toMatch(HASH_PATTERN);
  expect(request.toolsArraySha256).toMatch(HASH_PATTERN);
  expect(request.isolationCanarySha256).toMatch(HASH_PATTERN);
  if (request.responseIdSha256 !== null) {
    expect(request.responseIdSha256).toMatch(HASH_PATTERN);
  }
  expect(isPositiveSafeInteger(request.requestBodyBytes)).toBe(true);
  expect(isPositiveSafeInteger(request.toolsArrayBytes)).toBe(true);
  expect(isNonnegativeSafeInteger(request.latencyMs)).toBe(true);
  expect(isPositiveSafeInteger(request.requestSequence)).toBe(true);
  expect(request.trial).toBeGreaterThanOrEqual(1);
  expect(request.trial).toBeLessThanOrEqual(EXPECTED_TRIALS);
  expect(["first", "second"]).toContain(request.armPosition);
  expect(["control-first", "changed-first"]).toContain(request.pairOrder);
  expect(["warmup", "measure"]).toContain(request.phase);
  expect(SCENARIOS).toContain(request.scenario);
  expect(SCENARIO_VARIANTS[request.scenario]).toContain(request.variant);
  expectValidTimestamp(request.startedAt);
  expectValidTimestamp(request.completedAt);
  expect(Date.parse(request.completedAt)).toBeGreaterThanOrEqual(
    Date.parse(request.startedAt)
  );
  expect(request.httpSuccess).toBe(
    isNonnegativeSafeInteger(request.httpStatus) &&
      request.httpStatus >= 200 &&
      request.httpStatus < 300
  );
  expect(
    request.httpStatus === null ||
      (isNonnegativeSafeInteger(request.httpStatus) &&
        request.httpStatus >= 100 &&
        request.httpStatus <= 599)
  ).toBe(true);
  expect(
    request.responseToolCallCount === null ||
      isNonnegativeSafeInteger(request.responseToolCallCount)
  ).toBe(true);
  expect(
    request.responseFinishReasonStatuses === null ||
      (Array.isArray(request.responseFinishReasonStatuses) &&
        request.responseFinishReasonStatuses.length > 0 &&
        request.responseFinishReasonStatuses.every((status) =>
          FINISH_REASON_STATUSES.includes(status)
        ))
  ).toBe(true);
  expect(
    request.outputWasExactOk === null ||
      typeof request.outputWasExactOk === "boolean"
  ).toBe(true);
  expect(
    request.responseModel === null ||
      (typeof request.responseModel === "string" &&
        SAFE_MODEL_ID_PATTERN.test(request.responseModel))
  ).toBe(true);
  expect(request.responseModelMatchesRequested).toBe(
    request.responseModel === null
      ? null
      : request.responseModel === requestedModel
  );
  verifyRequestArtifacts(request, requestedModel, configuration);

  verifySourceBackedUsage(
    request,
    "cacheRead",
    "cacheReadTokens",
    "cacheReadSource",
    CACHE_READ_SOURCES
  );
  verifySourceBackedUsage(
    request,
    "cacheWrite",
    "cacheWriteTokens",
    "cacheWriteSource",
    CACHE_WRITE_SOURCES
  );
  verifySourceBackedUsage(
    request,
    "input",
    "inputTokens",
    "inputSource",
    INPUT_SOURCES
  );
  verifyUsageValue(request, "output", "outputTokens");
  verifyUsageValue(request, "total", "totalTokens");

  const expectedSuccess =
    request.httpSuccess &&
    request.responseToolCallCount === 0 &&
    finishReasonsAreAccepted(request.responseFinishReasonStatuses) &&
    request.outputWasExactOk === true;
  expect(request.success).toBe(expectedSuccess);
  verifyRequestErrorCode(request);
  expect(request.cacheTelemetryEligible).toBeTypeOf("boolean");
  if (request.phase === "warmup") {
    expect(request.cacheTelemetryEligible).toBe(
      localCacheTelemetryEligible(request)
    );
  }
  expect(request.warmupPrerequisitePassed === null).toBe(
    request.phase === "warmup"
  );
}

function verifyRequestErrorCode(request) {
  if (!request.httpSuccess) {
    expect(request.errorCode).toMatch(SAFE_ERROR_CODE_PATTERN);
  } else if (
    request.responseToolCallCount === null ||
    request.responseFinishReasonStatuses === null
  ) {
    expect(request.errorCode).toBe("invalid-response-shape");
  } else if (request.responseToolCallCount > 0) {
    expect(request.errorCode).toBe("unexpected-tool-call");
  } else if (!finishReasonsAreAccepted(request.responseFinishReasonStatuses)) {
    expect(request.errorCode).toBe("invalid-finish-reason");
  } else if (request.outputWasExactOk === null) {
    expect(request.errorCode).toBe("invalid-response-shape");
  } else if (request.outputWasExactOk === false) {
    expect(request.errorCode).toBe("unexpected-output");
  } else {
    expect(request.errorCode).toBeNull();
  }
}

function verifyRequestArtifacts(request, requestedModel, configuration) {
  const scenario = EVIDENCE_CAMPAIGN.scenarios.find(
    ({ name }) => name === request.scenario
  );
  expect(scenario).toBeDefined();
  const arm = scenario.arms.find(({ variant }) => variant === request.variant);
  expect(arm).toBeDefined();
  const isolationToken = isolationTokenFor({
    model: requestedModel,
    runId: configuration.runId,
    scenario: request.scenario,
    trial: request.trial,
    variant: request.variant,
  });
  const artifacts = benchmarkRequestArtifacts({
    isolationToken,
    model: requestedModel,
    namespace: `cache-arm-${isolationToken}`,
    prefixLines: configuration.prefixLines,
    toolNames:
      request.phase === "warmup" ? scenario.warmupTools : arm.measuredTools,
  });
  expect(request).toMatchObject({
    isolationCanarySha256: artifacts.isolationCanarySha256,
    requestBodyBytes: artifacts.requestBodyBytes,
    requestBodySha256: artifacts.requestBodySha256,
    toolsArrayBytes: artifacts.toolsArrayBytes,
    toolsArraySha256: artifacts.toolsArraySha256,
  });
}

function verifyMeasurementPrerequisites(model) {
  for (const measured of model.requests.filter(
    ({ phase }) => phase === "measure"
  )) {
    const warmup = model.requests.find(
      (request) =>
        request.phase === "warmup" &&
        request.scenario === measured.scenario &&
        request.trial === measured.trial &&
        request.variant === measured.variant
    );
    expect(warmup).toBeDefined();
    const prerequisitePassed =
      warmup.success && warmup.responseModelMatchesRequested === true;
    expect(measured.warmupPrerequisitePassed).toBe(prerequisitePassed);
    expect(measured.cacheTelemetryEligible).toBe(
      prerequisitePassed && localCacheTelemetryEligible(measured)
    );
  }
}

function verifySourceBackedUsage(
  request,
  auditField,
  valueField,
  sourceField,
  allowedSources
) {
  const status = request.usageFieldAudit[auditField];
  expect(USAGE_STATUSES).toContain(status);
  if (status === "valid") {
    expect(isNonnegativeSafeInteger(request[valueField])).toBe(true);
    expect(allowedSources.has(request[sourceField])).toBe(true);
  } else {
    expect(request[valueField]).toBeNull();
    expect(request[sourceField]).toBeNull();
  }
}

function verifyUsageValue(request, auditField, valueField) {
  const status = request.usageFieldAudit[auditField];
  expect(USAGE_STATUSES).toContain(status);
  if (status === "valid") {
    expect(isNonnegativeSafeInteger(request[valueField])).toBe(true);
  } else {
    expect(request[valueField]).toBeNull();
  }
}

function verifyIsolation(model) {
  const groups = groupBy(
    model.requests,
    (request) => `${request.scenario}:${request.trial}:${request.variant}`
  );
  expect(groups.size).toBe(ARMS_PER_MODEL);
  const canaries = [];
  for (const requests of groups.values()) {
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map(({ phase }) => phase))).toEqual(
      new Set(["warmup", "measure"])
    );
    expect(
      new Set(
        requests.map(({ isolationCanarySha256 }) => isolationCanarySha256)
      ).size
    ).toBe(1);
    const [warmup, measure] = [...requests].sort(
      (left, right) => left.requestSequence - right.requestSequence
    );
    expect(warmup.phase).toBe("warmup");
    expect(measure.phase).toBe("measure");
    expect(measure.requestSequence).toBe(warmup.requestSequence + 1);
    const unchanged = [
      "stable-order",
      "unchanged-active-set",
      "unchanged-membership",
    ].includes(measure.variant);
    expect(measure.toolsArraySha256 === warmup.toolsArraySha256).toBe(
      unchanged
    );
    expect(measure.requestBodySha256 === warmup.requestBodySha256).toBe(
      unchanged
    );
    canaries.push(requests[0].isolationCanarySha256);
  }
  expect(new Set(canaries).size).toBe(groups.size);
  const warmups = model.requests.filter(({ phase }) => phase === "warmup");
  expect(
    new Set(warmups.map(({ toolsArraySha256 }) => toolsArraySha256)).size
  ).toBe(warmups.length);
  expect(
    new Set(warmups.map(({ toolsArrayBytes }) => toolsArrayBytes)).size
  ).toBe(1);
  for (const scenario of ["same-set-order", "membership-only-change"]) {
    for (const trial of TRIAL_NUMBERS) {
      const measured = model.requests.filter(
        (request) =>
          request.phase === "measure" &&
          request.scenario === scenario &&
          request.trial === trial
      );
      expect(measured).toHaveLength(2);
      expect(
        new Set(measured.map(({ toolsArrayBytes }) => toolsArrayBytes)).size
      ).toBe(1);
      expect(
        new Set(measured.map(({ requestBodyBytes }) => requestBodyBytes)).size
      ).toBe(1);
    }
  }
  expect(model.isolationAudit).toEqual({
    allArmsHaveOneWarmupAndOneMeasure: true,
    allWarmupMeasurePairsShareCanary: true,
    armCount: ARMS_PER_MODEL,
    canariesUniqueAcrossArms: true,
    membershipChangeIsEqualByteSwap: true,
    sameSetOrderIsEqualByteSwap: true,
    unexpectedToolCallResponseCount: model.requests.filter(
      ({ responseToolCallCount }) => (responseToolCallCount ?? 0) > 0
    ).length,
    uniqueCanaryHashCount: ARMS_PER_MODEL,
    uniqueWarmupToolsArrayByteCount: 1,
    uniqueWarmupToolsArrayHashCount: ARMS_PER_MODEL,
    warmupCount: ARMS_PER_MODEL,
  });
}

function verifyMembershipInputTokenParity(model) {
  const measured = model.requests.filter(
    (request) =>
      request.phase === "measure" &&
      request.scenario === "membership-only-change"
  );
  const pairs = TRIAL_NUMBERS.flatMap((trial) => {
    const control = measured.find(
      (request) =>
        request.trial === trial && request.variant === "unchanged-membership"
    );
    const changed = measured.find(
      (request) =>
        request.trial === trial && request.variant === "changed-membership"
    );
    if (!(inputParityEligible(control) && inputParityEligible(changed))) {
      return [];
    }
    expectPairedCoordinates(control, changed);
    return [
      {
        changedInputTokens: changed.inputTokens,
        controlInputTokens: control.inputTokens,
        controlMinusChangedInputTokens: safeIntegerDifference(
          control.inputTokens,
          changed.inputTokens,
          "membership input-token difference"
        ),
        pairOrder: control.pairOrder,
        trial,
      },
    ];
  });
  const differences = pairs.map(
    ({ controlMinusChangedInputTokens }) => controlMinusChangedInputTokens
  );
  const orderStrata = PAIR_ORDER_VALUES.map((pairOrder) => {
    const stratumDifferences = pairs
      .filter((pair) => pair.pairOrder === pairOrder)
      .map((pair) => pair.controlMinusChangedInputTokens);
    return {
      pairOrder,
      ...differenceSummary(stratumDifferences),
    };
  });
  const expectedPairsByOrder = Object.fromEntries(
    PAIR_ORDER_VALUES.map((pairOrder) => [
      pairOrder,
      measured.filter(
        (request) =>
          request.variant === "unchanged-membership" &&
          request.pairOrder === pairOrder
      ).length,
    ])
  );
  expect(pairs.length).toBeGreaterThanOrEqual(
    EXPECTED_TRIALS * MIN_STRATUM_COVERAGE
  );
  expect(model.membershipInputTokenParityAudit).toEqual({
    changedHigher: differences.filter((difference) => difference < 0).length,
    controlHigher: differences.filter((difference) => difference > 0).length,
    effectConclusion: directionalEffectConclusion(
      orderStrata,
      expectedPairsByOrder
    ),
    eligiblePairs: pairs.length,
    equal: differences.filter((difference) => difference === 0).length,
    missingPairs: EXPECTED_TRIALS - pairs.length,
    orderStrata,
    pairs,
  });
}

function differenceSummary(differences) {
  return {
    changedHigher: differences.filter((difference) => difference < 0).length,
    controlHigher: differences.filter((difference) => difference > 0).length,
    eligiblePairs: differences.length,
    equal: differences.filter((difference) => difference === 0).length,
    medianDifference: quantile(differences, 0.5),
  };
}

function directionalEffectConclusion(orderStrata, expectedPairsByOrder) {
  if (
    orderStrata.some(({ eligiblePairs, pairOrder }) => {
      const expected = expectedPairsByOrder[pairOrder];
      return (
        expected === 0 ||
        eligiblePairs < Math.ceil(expected * MIN_STRATUM_COVERAGE)
      );
    })
  ) {
    return "indeterminate-insufficient-order-stratum-coverage";
  }
  const medians = orderStrata.map((stratum) => stratum.medianDifference);
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

function inputParityEligible(request) {
  return Boolean(
    request?.success &&
      request.responseModelMatchesRequested === true &&
      request.warmupPrerequisitePassed === true &&
      request.usageFieldAudit.input === "valid" &&
      isNonnegativeSafeInteger(request.inputTokens)
  );
}

function verifyRequestOutcomes(model) {
  const captureSuccessful = model.requests.filter(({ success }) => success);
  const measured = model.requests.filter(({ phase }) => phase === "measure");
  expect(model.requestOutcomeAudit).toEqual({
    cacheUsageEnvelopeAudited: captureSuccessful.length,
    cacheUsageEnvelopeUnavailable:
      model.requests.length - captureSuccessful.length,
    cacheTelemetryEligible: model.requests.filter(
      ({ cacheTelemetryEligible }) => cacheTelemetryEligible
    ).length,
    captureSuccess: model.requests.filter(({ success }) => success).length,
    httpSuccess: model.requests.filter(({ httpSuccess }) => httpSuccess).length,
    invalidCacheUsageEnvelope: captureSuccessful.filter(
      (request) => !cacheUsageEnvelopeIsValid(request)
    ).length,
    invalidResponseShape: model.requests.filter(
      ({ errorCode }) => errorCode === "invalid-response-shape"
    ).length,
    invalidFinishReason: model.requests.filter(
      ({ errorCode }) => errorCode === "invalid-finish-reason"
    ).length,
    unexpectedOutput: model.requests.filter(
      ({ errorCode }) => errorCode === "unexpected-output"
    ).length,
    measuredCacheTelemetryEligible: measured.filter(
      ({ cacheTelemetryEligible }) => cacheTelemetryEligible
    ).length,
    measuredLocalCacheTelemetryEligible: measured.filter(
      localCacheTelemetryEligible
    ).length,
    measuredWarmupPrerequisiteFailures: measured.filter(
      ({ warmupPrerequisitePassed }) => warmupPrerequisitePassed === false
    ).length,
    positiveToolCallResponses: model.requests.filter(
      ({ responseToolCallCount }) => (responseToolCallCount ?? 0) > 0
    ).length,
    requests: model.requests.length,
  });
}

function verifyResponseModelAudit(model) {
  expect(model.responseModelAudit).toEqual({
    all: responseModelSummary(model.requests),
    measure: responseModelSummary(
      model.requests.filter(({ phase }) => phase === "measure")
    ),
    warmup: responseModelSummary(
      model.requests.filter(({ phase }) => phase === "warmup")
    ),
  });
}

function responseModelSummary(requests) {
  const observed = new Map();
  for (const request of requests) {
    if (request.responseModel !== null) {
      observed.set(
        request.responseModel,
        (observed.get(request.responseModel) ?? 0) + 1
      );
    }
  }
  return {
    responses: requests.length,
    modelReported: requests.filter(
      ({ responseModel }) => responseModel !== null
    ).length,
    observedResponseModels: Object.fromEntries(observed),
    requestedModelMatches: requests.filter(
      ({ responseModelMatchesRequested }) =>
        responseModelMatchesRequested === true
    ).length,
    requestedModelMismatches: requests.filter(
      ({ responseModelMatchesRequested }) =>
        responseModelMatchesRequested === false
    ).length,
    requestedModelMissing: requests.filter(
      ({ responseModelMatchesRequested }) =>
        responseModelMatchesRequested === null
    ).length,
  };
}

function verifyFinishReasonAudit(model) {
  expect(model.finishReasonAudit).toEqual({
    all: finishReasonSummary(model.requests),
    measure: finishReasonSummary(
      model.requests.filter(({ phase }) => phase === "measure")
    ),
    warmup: finishReasonSummary(
      model.requests.filter(({ phase }) => phase === "warmup")
    ),
  });
}

function finishReasonSummary(requests) {
  const statuses = requests.flatMap(
    ({ responseFinishReasonStatuses }) => responseFinishReasonStatuses ?? []
  );
  return {
    acceptedResponses: requests.filter(({ responseFinishReasonStatuses }) =>
      finishReasonsAreAccepted(responseFinishReasonStatuses)
    ).length,
    choicesAudited: statuses.length,
    responseShapeUnavailable: requests.filter(
      ({ responseFinishReasonStatuses }) =>
        responseFinishReasonStatuses === null
    ).length,
    responses: requests.length,
    statusCounts: Object.fromEntries(
      FINISH_REASON_STATUSES.map((status) => [
        status,
        statuses.filter((observed) => observed === status).length,
      ])
    ),
  };
}

function finishReasonsAreAccepted(statuses) {
  return (
    statuses !== null &&
    statuses.length > 0 &&
    statuses.every((status) => status === "accepted-stop")
  );
}

function verifyOutputCompliance(model) {
  const summarize = (requests) => ({
    exact: requests.filter(({ outputWasExactOk }) => outputWasExactOk === true)
      .length,
    mismatch: requests.filter(
      ({ outputWasExactOk }) => outputWasExactOk === false
    ).length,
    unavailable: requests.filter(
      ({ outputWasExactOk }) => outputWasExactOk === null
    ).length,
  });
  expect(model.outputComplianceAudit).toEqual({
    all: summarize(model.requests),
    measure: summarize(
      model.requests.filter(({ phase }) => phase === "measure")
    ),
    warmup: summarize(model.requests.filter(({ phase }) => phase === "warmup")),
  });
}

function verifyUsageFieldStatusAudit(model) {
  const expected = {};
  for (const field of ["cacheRead", "cacheWrite", "input", "output", "total"]) {
    expected[field] = Object.fromEntries(
      USAGE_STATUSES.map((status) => [
        status,
        model.requests.filter(
          (request) => request.usageFieldAudit[field] === status
        ).length,
      ])
    );
  }
  expect(model.usageFieldStatusAudit).toEqual(expected);
}

function verifyComparisons(model) {
  expect(model.comparisons.map(({ scenario }) => scenario)).toEqual(SCENARIOS);
  for (const comparison of model.comparisons) {
    const [controlVariant, changedVariant] =
      SCENARIO_VARIANTS[comparison.scenario];
    expect(comparison.controlVariant).toBe(controlVariant);
    expect(comparison.changedVariant).toBe(changedVariant);
    const control = measuredVariant(
      model.requests,
      comparison.scenario,
      controlVariant
    );
    const changed = measuredVariant(
      model.requests,
      comparison.scenario,
      changedVariant
    );
    const pairs = buildPairs(control, changed);
    expect(comparison.pairs).toEqual(pairs);
    expect(pickPairedSummary(comparison)).toEqual(summarizePairs(pairs));
    expect(comparison.orderStrata.map(({ pairOrder }) => pairOrder)).toEqual(
      PAIR_ORDER_VALUES
    );
    for (const stratum of comparison.orderStrata) {
      expect(pickPairedSummary(stratum)).toEqual(
        summarizePairs(
          pairs.filter(({ pairOrder }) => pairOrder === stratum.pairOrder)
        )
      );
    }
    expect(comparison.effectConclusion).toBe(
      directionalEffectConclusion(
        comparison.orderStrata.map((stratum) => ({
          eligiblePairs: stratum.eligiblePairs,
          medianDifference: stratum.medianControlMinusChangedCacheReadTokens,
          pairOrder: stratum.pairOrder,
        })),
        Object.fromEntries(
          PAIR_ORDER_VALUES.map((pairOrder) => [
            pairOrder,
            control.filter((request) => request.pairOrder === pairOrder).length,
          ])
        )
      )
    );
  }
}

function verifySummaries(model) {
  expect(model.summaries).toHaveLength(
    SCENARIOS.length * VARIANTS_PER_SCENARIO
  );
  for (const summary of model.summaries) {
    const requests = measuredVariant(
      model.requests,
      summary.scenario,
      summary.variant
    );
    expect(summary).toEqual({
      scenario: summary.scenario,
      variant: summary.variant,
      ...variantSummary(requests),
    });
  }
}

function verifyCounterbalance(evidence) {
  const assignments = evidence.configuration.armExecutionOrder.orderAssignments;
  for (const model of EXPECTED_MODELS) {
    for (const scenario of SCENARIOS) {
      verifyCounterbalanceStratum(evidence, assignments, model, scenario);
    }
  }
}

function verifyCounterbalanceStratum(evidence, assignments, model, scenario) {
  const stratum = assignments.filter(
    (entry) => entry.model === model && entry.scenario === scenario
  );
  expect(stratum.map(({ trial }) => trial)).toEqual(TRIAL_NUMBERS);
  expect(stratum.map(({ pairOrder }) => pairOrder)).toEqual(
    TRIAL_NUMBERS.map((trial) =>
      pairOrderFor({
        model,
        scenario,
        seed: EVIDENCE_CAMPAIGN.seed,
        trial,
      })
    )
  );
  expect(
    stratum.filter(({ pairOrder }) => pairOrder === "control-first")
  ).toHaveLength(EXPECTED_TRIALS / PAIR_ORDERS);
  expect(
    stratum.filter(({ pairOrder }) => pairOrder === "changed-first")
  ).toHaveLength(EXPECTED_TRIALS / PAIR_ORDERS);
  for (let index = 1; index < stratum.length; index += 1) {
    expect(stratum[index].pairOrder).not.toBe(stratum[index - 1].pairOrder);
  }
  for (const assignment of stratum) {
    verifyAssignment(evidence, model, scenario, assignment);
  }
}

function verifyAssignment(evidence, model, scenario, assignment) {
  const [control, changed] = SCENARIO_VARIANTS[scenario];
  expect(assignment.variants).toEqual(
    assignment.pairOrder === "control-first"
      ? [control, changed]
      : [changed, control]
  );
  const requests = evidence.models
    .find((entry) => entry.model === model)
    .requests.filter(
      (request) =>
        request.scenario === scenario && request.trial === assignment.trial
    );
  for (const request of requests) {
    expect(request.pairOrder).toBe(assignment.pairOrder);
    expect(request.armPosition).toBe(
      request.variant === assignment.variants[0] ? "first" : "second"
    );
  }
}

function buildPairs(control, changed) {
  return control.flatMap((controlRequest) => {
    const changedRequest = changed.find(
      ({ trial }) => trial === controlRequest.trial
    );
    if (
      !(
        controlRequest.cacheTelemetryEligible &&
        changedRequest?.cacheTelemetryEligible &&
        cacheMeasurementIsValid(controlRequest) &&
        cacheMeasurementIsValid(changedRequest)
      )
    ) {
      return [];
    }
    expectPairedCoordinates(controlRequest, changedRequest);
    return [
      {
        changedCacheReadRatio: ratio(changedRequest),
        changedCacheReadTokens: changedRequest.cacheReadTokens,
        changedInputTokens: changedRequest.inputTokens,
        changedLatencyMs: changedRequest.latencyMs,
        controlCacheReadRatio: ratio(controlRequest),
        controlCacheReadTokens: controlRequest.cacheReadTokens,
        controlInputTokens: controlRequest.inputTokens,
        controlLatencyMs: controlRequest.latencyMs,
        controlMinusChangedCacheReadTokens: safeIntegerDifference(
          controlRequest.cacheReadTokens,
          changedRequest.cacheReadTokens,
          "paired cache-read-token difference"
        ),
        controlMinusChangedInputTokens: safeIntegerDifference(
          controlRequest.inputTokens,
          changedRequest.inputTokens,
          "paired input-token difference"
        ),
        controlMinusChangedLatencyMs: safeIntegerDifference(
          controlRequest.latencyMs,
          changedRequest.latencyMs,
          "paired latency difference"
        ),
        pairOrder: controlRequest.pairOrder,
        trial: controlRequest.trial,
      },
    ];
  });
}

function expectPairedCoordinates(control, changed) {
  expect(changed.trial).toBe(control.trial);
  expect(changed.scenario).toBe(control.scenario);
  expect(changed.pairOrder).toBe(control.pairOrder);
  if (control.pairOrder === "control-first") {
    expect(control.armPosition).toBe("first");
    expect(changed.armPosition).toBe("second");
  } else {
    expect(control.armPosition).toBe("second");
    expect(changed.armPosition).toBe("first");
  }
}

function summarizePairs(pairs) {
  const cacheDifferences = pairs.map(
    ({ controlMinusChangedCacheReadTokens }) =>
      controlMinusChangedCacheReadTokens
  );
  const inputDifferences = pairs.map(
    ({ controlMinusChangedInputTokens }) => controlMinusChangedInputTokens
  );
  const ratioDifferences = pairs.flatMap((pair) =>
    pair.controlCacheReadRatio === null || pair.changedCacheReadRatio === null
      ? []
      : [pair.controlCacheReadRatio - pair.changedCacheReadRatio]
  );
  return {
    cacheReadTokenDifferenceSigns: differenceSigns(cacheDifferences),
    eligiblePairs: pairs.length,
    inputTokenDifferenceSigns: differenceSigns(inputDifferences),
    medianControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.5),
    medianControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.5),
    medianControlMinusChangedInputTokens: quantile(inputDifferences, 0.5),
    medianControlMinusChangedLatencyMs: quantile(
      pairs.map(
        ({ controlMinusChangedLatencyMs }) => controlMinusChangedLatencyMs
      ),
      0.5
    ),
    p25ControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.25),
    p25ControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.25),
    p25ControlMinusChangedInputTokens: quantile(inputDifferences, 0.25),
    p75ControlMinusChangedCacheReadRatio: quantile(ratioDifferences, 0.75),
    p75ControlMinusChangedCacheReadTokens: quantile(cacheDifferences, 0.75),
    p75ControlMinusChangedInputTokens: quantile(inputDifferences, 0.75),
  };
}

function pickPairedSummary(value) {
  const {
    cacheReadTokenDifferenceSigns,
    eligiblePairs,
    inputTokenDifferenceSigns,
    medianControlMinusChangedCacheReadRatio,
    medianControlMinusChangedCacheReadTokens,
    medianControlMinusChangedInputTokens,
    medianControlMinusChangedLatencyMs,
    p25ControlMinusChangedCacheReadRatio,
    p25ControlMinusChangedCacheReadTokens,
    p25ControlMinusChangedInputTokens,
    p75ControlMinusChangedCacheReadRatio,
    p75ControlMinusChangedCacheReadTokens,
    p75ControlMinusChangedInputTokens,
  } = value;
  return {
    cacheReadTokenDifferenceSigns,
    eligiblePairs,
    inputTokenDifferenceSigns,
    medianControlMinusChangedCacheReadRatio,
    medianControlMinusChangedCacheReadTokens,
    medianControlMinusChangedInputTokens,
    medianControlMinusChangedLatencyMs,
    p25ControlMinusChangedCacheReadRatio,
    p25ControlMinusChangedCacheReadTokens,
    p25ControlMinusChangedInputTokens,
    p75ControlMinusChangedCacheReadRatio,
    p75ControlMinusChangedCacheReadTokens,
    p75ControlMinusChangedInputTokens,
  };
}

function variantSummary(requests) {
  const eligible = requests.filter(
    ({ cacheTelemetryEligible }) => cacheTelemetryEligible
  );
  const reported = eligible.filter(cacheMeasurementIsValid);
  const writeReported = eligible.filter(cacheWriteMeasurementIsValid);
  const ratioEligible = reported.filter(({ inputTokens }) => inputTokens > 0);
  const writeRatioEligible = writeReported.filter(
    ({ inputTokens }) => inputTokens > 0
  );
  const cacheReadSum = safeTokenSum(
    ratioEligible.map(({ cacheReadTokens }) => cacheReadTokens),
    "weighted cache-read tokens"
  );
  const inputSum = safeTokenSum(
    ratioEligible.map(({ inputTokens }) => inputTokens),
    "weighted cache-read input tokens"
  );
  const writeSum = safeTokenSum(
    writeRatioEligible.map(({ cacheWriteTokens }) => cacheWriteTokens),
    "weighted cache-write tokens"
  );
  const writeInputSum = safeTokenSum(
    writeRatioEligible.map(({ inputTokens }) => inputTokens),
    "weighted cache-write input tokens"
  );
  const nonzero = reported.filter(
    ({ cacheReadTokens }) => cacheReadTokens > 0
  ).length;
  const writeNonzero = writeReported.filter(
    ({ cacheWriteTokens }) => cacheWriteTokens > 0
  ).length;
  return {
    attempts: requests.length,
    cacheReadNonzero: nonzero,
    cacheReadNonzeroCoverage:
      eligible.length === 0 ? null : nonzero / eligible.length,
    cacheReadReported: reported.length,
    cacheReportCoverage:
      eligible.length === 0 ? null : reported.length / eligible.length,
    cacheTelemetryEligible: eligible.length,
    cacheWriteNonzero: writeNonzero,
    cacheWriteNonzeroCoverage:
      eligible.length === 0 ? null : writeNonzero / eligible.length,
    cacheWriteReported: writeReported.length,
    cacheWriteReportCoverage:
      eligible.length === 0 ? null : writeReported.length / eligible.length,
    captureSuccesses: requests.filter(({ success }) => success).length,
    medianCacheReadRatio: quantile(
      ratioEligible.map(
        ({ cacheReadTokens, inputTokens }) => cacheReadTokens / inputTokens
      ),
      0.5
    ),
    medianCacheReadTokens: quantile(
      reported.map(({ cacheReadTokens }) => cacheReadTokens),
      0.5
    ),
    medianCacheWriteRatio: quantile(
      writeRatioEligible.map(
        ({ cacheWriteTokens, inputTokens }) => cacheWriteTokens / inputTokens
      ),
      0.5
    ),
    medianCacheWriteTokens: quantile(
      writeReported.map(({ cacheWriteTokens }) => cacheWriteTokens),
      0.5
    ),
    medianInputTokens: quantile(
      eligible.flatMap(({ inputTokens }) =>
        isNonnegativeSafeInteger(inputTokens) ? [inputTokens] : []
      ),
      0.5
    ),
    medianLatencyMs: quantile(
      eligible.map(({ latencyMs }) => latencyMs),
      0.5
    ),
    weightedCacheReadRatio: inputSum === 0 ? null : cacheReadSum / inputSum,
    weightedCacheWriteRatio:
      writeInputSum === 0 ? null : writeSum / writeInputSum,
  };
}

function reportingStatus(requests) {
  const eligible = requests.filter(
    (request) => request.phase === "measure" && request.cacheTelemetryEligible
  );
  if (eligible.length === 0) {
    return "unavailable";
  }
  const reported = eligible.filter(cacheMeasurementIsValid);
  if (reported.length === 0) {
    return "not-reported";
  }
  return reported.some(({ cacheReadTokens }) => cacheReadTokens > 0)
    ? "reported-nonzero"
    : "reported-zero-only";
}

function cacheWriteReportingStatus(requests) {
  const eligible = requests.filter(
    (request) => request.phase === "measure" && request.cacheTelemetryEligible
  );
  if (eligible.length === 0) {
    return "unavailable";
  }
  const reported = eligible.filter(cacheWriteMeasurementIsValid);
  if (reported.length === 0) {
    return "not-reported";
  }
  return reported.some(({ cacheWriteTokens }) => cacheWriteTokens > 0)
    ? "reported-nonzero"
    : "reported-zero-only";
}

function localCacheTelemetryEligible(request) {
  return (
    request.success &&
    request.responseModelMatchesRequested === true &&
    cacheUsageEnvelopeIsValid(request)
  );
}

function cacheUsageEnvelopeIsValid(request) {
  return (
    request.usageFieldAudit.input === "valid" &&
    ["absent", "valid"].includes(request.usageFieldAudit.cacheRead) &&
    ["absent", "valid"].includes(request.usageFieldAudit.cacheWrite) &&
    isNonnegativeSafeInteger(request.inputTokens) &&
    (request.cacheReadTokens === null ||
      (isNonnegativeSafeInteger(request.cacheReadTokens) &&
        request.cacheReadTokens <= request.inputTokens)) &&
    (request.cacheWriteTokens === null ||
      (isNonnegativeSafeInteger(request.cacheWriteTokens) &&
        request.cacheWriteTokens <= request.inputTokens)) &&
    (request.cacheReadTokens === null ||
      request.cacheWriteTokens === null ||
      cacheComponentsFitInput(
        request.cacheReadTokens,
        request.cacheWriteTokens,
        request.inputTokens
      ))
  );
}

function cacheMeasurementIsValid(request) {
  return (
    request.usageFieldAudit.input === "valid" &&
    request.usageFieldAudit.cacheRead === "valid" &&
    ["absent", "valid"].includes(request.usageFieldAudit.cacheWrite) &&
    isNonnegativeSafeInteger(request.inputTokens) &&
    isNonnegativeSafeInteger(request.cacheReadTokens) &&
    request.cacheReadTokens <= request.inputTokens &&
    (request.cacheWriteTokens === null ||
      (isNonnegativeSafeInteger(request.cacheWriteTokens) &&
        request.cacheWriteTokens <= request.inputTokens &&
        cacheComponentsFitInput(
          request.cacheReadTokens,
          request.cacheWriteTokens,
          request.inputTokens
        )))
  );
}

function cacheWriteMeasurementIsValid(request) {
  return (
    request.usageFieldAudit.input === "valid" &&
    request.usageFieldAudit.cacheWrite === "valid" &&
    ["absent", "valid"].includes(request.usageFieldAudit.cacheRead) &&
    isNonnegativeSafeInteger(request.inputTokens) &&
    isNonnegativeSafeInteger(request.cacheWriteTokens) &&
    request.cacheWriteTokens <= request.inputTokens &&
    (request.cacheReadTokens === null ||
      (isNonnegativeSafeInteger(request.cacheReadTokens) &&
        request.cacheReadTokens <= request.inputTokens &&
        cacheComponentsFitInput(
          request.cacheReadTokens,
          request.cacheWriteTokens,
          request.inputTokens
        )))
  );
}

function ratio(request) {
  return cacheMeasurementIsValid(request) && request.inputTokens > 0
    ? request.cacheReadTokens / request.inputTokens
    : null;
}

function differenceSigns(values) {
  return {
    changedHigher: values.filter((value) => value < 0).length,
    controlHigher: values.filter((value) => value > 0).length,
    equal: values.filter((value) => value === 0).length,
  };
}

function measuredVariant(requests, scenario, variant) {
  return requests.filter(
    (request) =>
      request.phase === "measure" &&
      request.scenario === scenario &&
      request.variant === variant
  );
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

function safeTokenSum(values, context) {
  let total = 0;
  for (const value of values) {
    if (!isNonnegativeSafeInteger(value)) {
      throw new RangeError(`${context} contains an unsafe token count.`);
    }
    const next = total + value;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(`${context} exceeded the safe integer range.`);
    }
    total = next;
  }
  return total;
}

function cacheComponentsFitInput(
  cacheReadTokens,
  cacheWriteTokens,
  inputTokens
) {
  const total = cacheReadTokens + cacheWriteTokens;
  return Number.isSafeInteger(total) && total <= inputTokens;
}

function safeIntegerDifference(left, right, context) {
  if (!(Number.isSafeInteger(left) && Number.isSafeInteger(right))) {
    throw new RangeError(`${context} contains an unsafe integer.`);
  }
  const difference = left - right;
  if (!Number.isSafeInteger(difference)) {
    throw new RangeError(`${context} exceeded the safe integer range.`);
  }
  return difference;
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function expectExactKeys(value, keys) {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function expectValidTimestamp(value) {
  expect(typeof value).toBe("string");
  const timestamp = Date.parse(value);
  expect(Number.isFinite(timestamp)).toBe(true);
  expect(new Date(timestamp).toISOString()).toBe(value);
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function findForbiddenKeys(value, path = "result", found = []) {
  if (!(value && typeof value === "object")) {
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      findForbiddenKeys(entry, `${path}[${index}]`, found);
    });
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(key.toLowerCase())) {
      found.push(`${path}.${key}`);
    }
    findForbiddenKeys(child, `${path}.${key}`, found);
  }
  return found;
}
