import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompletionResponse } from "./broad-context-cache-response.mjs";
import { validatedFreerouterBaseUrl } from "./freerouter-url.mjs";

const benchmarkSourceEntries = [
  ["broad-context-cache-benchmark.mjs", new URL(import.meta.url)],
  [
    "broad-context-cache-response.mjs",
    new URL("./broad-context-cache-response.mjs", import.meta.url),
  ],
  ["freerouter-url.mjs", new URL("./freerouter-url.mjs", import.meta.url)],
];
const benchmarkSource = sourceManifest(benchmarkSourceEntries);

const fixtureOnly = process.env.PSS_LIVE_FIXTURE_ONLY === "true";
const confirmationMode = process.env.PSS_LIVE_CONFIRMATION === "true";
const apiKey = process.env.FREEROUTER_API_KEY?.trim();
const baseURL = fixtureOnly
  ? undefined
  : validatedFreerouterBaseUrl(process.env.FREEROUTER_BASE_URL);
if (!(fixtureOnly || apiKey)) {
  throw new Error("FREEROUTER_BASE_URL and FREEROUTER_API_KEY are required");
}

const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const BEARER_CREDENTIAL_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/iu;
const CACHE_READ_PATHS = [
  "prompt_tokens_details.cached_tokens",
  "input_tokens_details.cached_tokens",
  "prompt_tokens_details.cache_read_tokens",
  "input_tokens_details.cache_read_tokens",
  "cache_read_input_tokens",
  "cache_read_tokens",
  "cached_input_tokens",
];
const CACHE_WRITE_PATHS = [
  "prompt_tokens_details.cache_write_tokens",
  "input_tokens_details.cache_write_tokens",
  "prompt_tokens_details.cache_creation_tokens",
  "input_tokens_details.cache_creation_tokens",
  "cache_creation_input_tokens",
  "cache_write_input_tokens",
  "cache_write_tokens",
];
const INPUT_PATHS = ["prompt_tokens", "input_tokens"];

const positionalArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const scenarioId = positionalArgs[0];
const repoRoot = resolveRepoRoot(positionalArgs[1]);
const steps = positiveIntegerEnv("PSS_LIVE_STEPS", 6, 6);
const targetChunkCharacters = positiveIntegerEnv(
  "PSS_LIVE_CHUNK_CHARACTERS",
  60_000,
  1_000_000
);
const highWaterTokens = positiveIntegerEnv(
  "PSS_LIVE_HIGH_WATER_TOKENS",
  75_000,
  10_000_000
);
const miniMaxOutputTokens = positiveIntegerEnv(
  "PSS_LIVE_MINIMAX_MAX_OUTPUT_TOKENS",
  256,
  4096
);

const modelConfigs = [
  {
    contextLength: 204_800,
    id: "minimaxai/minimax-m2.7",
    request: { include_reasoning: false, max_tokens: miniMaxOutputTokens },
  },
  {
    contextLength: 262_144,
    id: "mistralai/ministral-14b-latest",
    request: { max_tokens: 160 },
  },
  {
    contextLength: 202_752,
    id: "zai-org/glm-4.7",
    request: {
      include_reasoning: false,
      max_tokens: 160,
      reasoning_effort: "none",
    },
  },
  {
    contextLength: 10_485_760,
    id: "meta-llama/llama-4-scout-17b-16e-instruct",
    request: { max_tokens: 160 },
  },
];

const policies = [
  { kind: "always", name: "legacy-rewrite-every-step" },
  { kind: "high-water", name: "high-water-stable-prefix" },
];

const selectedModelIds = csvEnv("PSS_LIVE_MODELS");
const selectedPolicyNames = csvEnv("PSS_LIVE_POLICIES");
const selectedModels = modelConfigs.filter(
  (model) =>
    selectedModelIds.length === 0 || selectedModelIds.includes(model.id)
);
const selectedPolicies = policies.filter(
  (policy) =>
    selectedPolicyNames.length === 0 ||
    selectedPolicyNames.includes(policy.name)
);
if (selectedModels.length === 0 || selectedPolicies.length === 0) {
  throw new Error("model and policy filters must select at least one entry");
}
if (
  confirmationMode &&
  (steps !== 6 ||
    targetChunkCharacters !== 60_000 ||
    highWaterTokens !== 75_000 ||
    miniMaxOutputTokens !== 256)
) {
  throw new Error(
    "confirmation mode requires the preregistered 6 steps, 60K-character chunks, 75K reference high-water, and 256-token MiniMax default"
  );
}

const scenario = buildScenario(scenarioId, repoRoot);
async function main() {
  if (fixtureOnly) {
    console.log(JSON.stringify(fixtureManifest(scenario), null, 2));
    return;
  }

  const campaignStartedAt = new Date().toISOString();
  const modelCatalog = await requestModelCatalog();
  const runs = confirmationMode
    ? await runConfirmation(scenario)
    : await Promise.all(
        selectedModels.flatMap((model) =>
          selectedPolicies.map(
            async (policy) => await runPolicy({ model, policy, scenario })
          )
        )
      );

  const report = {
    benchmarkSource,
    checkedInContent: {
      modelOutputs: false,
      perTurnTelemetry: true,
      prompts: false,
      rawBodies: false,
    },
    config: {
      confirmationMode,
      correctness: {
        strict:
          "Trimmed response must parse as one JSON object with exactly the requested keys and exact values.",
        tokenRecallProxy:
          "Legacy expected-token containment is retained as a separate recall proxy and never substitutes for strict correctness.",
      },
      highWaterTokens,
      maximumHttpAttemptsPerTurn: confirmationMode ? 1 : 2,
      models: selectedModels.map(({ contextLength, id, request }) => ({
        contextLength,
        id,
        maxOutputTokens: request.max_tokens,
      })),
      steps,
      targetChunkCharacters,
      ...(confirmationMode
        ? {
            confirmationOrder: [
              "uniform",
              "route-aware",
              "route-aware",
              "uniform",
            ],
          }
        : {}),
    },
    campaignCompletedAt: new Date().toISOString(),
    campaignStartedAt,
    credentialRecorded: false,
    endpoint: baseURL,
    fixture: fixtureManifest(scenario),
    modelCatalog,
    runs,
    scenario: scenario.id,
    schemaVersion: 2,
  };
  const completedSource = sourceManifest(benchmarkSourceEntries);
  if (JSON.stringify(completedSource) !== JSON.stringify(benchmarkSource)) {
    throw new Error("benchmark source changed while the campaign was running");
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (
    apiKey &&
    (serialized.includes(apiKey) || BEARER_CREDENTIAL_PATTERN.test(serialized))
  ) {
    throw new Error("refusing to print a report containing the credential");
  }
  process.stdout.write(serialized);
}

async function requestModelCatalog() {
  const requestedModelIds = selectedModels.map((model) => model.id);
  const checkedAt = new Date().toISOString();
  const response = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `model catalog preflight failed with HTTP ${response.status}`
    );
  }
  const body = await response.json().catch(() => undefined);
  if (!Array.isArray(body?.data)) {
    throw new Error("model catalog preflight returned an invalid data array");
  }
  const availableIds = new Set(
    body.data.flatMap((entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.id === "string" &&
      SAFE_MODEL_ID_PATTERN.test(entry.id)
        ? [entry.id]
        : []
    )
  );
  const presentModelIds = requestedModelIds.filter((id) =>
    availableIds.has(id)
  );
  const missingModelIds = requestedModelIds.filter(
    (id) => !availableIds.has(id)
  );
  if (missingModelIds.length > 0) {
    throw new Error(
      `model catalog preflight did not find requested model(s): ${missingModelIds.join(", ")}`
    );
  }
  return {
    available: true,
    checkedAt,
    httpStatus: response.status,
    presentModelIds,
    requestedModelIds,
    status: "passed",
  };
}

async function runConfirmation(scenario) {
  const expectedModelId = {
    conversation: "minimaxai/minimax-m2.7",
    "file-search": "mistralai/ministral-14b-latest",
  }[scenario.id];
  if (!expectedModelId) {
    throw new Error(
      "confirmation mode supports file-search/Ministral or conversation/MiniMax"
    );
  }
  if (
    selectedModels.length !== 1 ||
    selectedModels[0]?.id !== expectedModelId
  ) {
    throw new Error(
      `confirmation mode for ${scenario.id} requires PSS_LIVE_MODELS=${expectedModelId}`
    );
  }

  const model = selectedModels[0];
  const arms = confirmationArms(scenario.id);
  const order = ["uniform", "route-aware", "route-aware", "uniform"];
  const occurrences = new Map();
  const runs = [];
  for (const [orderIndex, arm] of order.entries()) {
    const replicate = (occurrences.get(arm) ?? 0) + 1;
    occurrences.set(arm, replicate);
    const config = arms[arm];
    runs.push(
      await runPolicy({
        arm,
        highWaterTokensOverride: config.highWaterTokens,
        maxOutputTokens: config.maxOutputTokens,
        model,
        orderIndex,
        policy: { kind: "high-water", name: "high-water-stable-prefix" },
        replicate,
        scenario,
      })
    );
  }
  return runs;
}

function confirmationArms(scenarioId) {
  if (scenarioId === "file-search") {
    return {
      "route-aware": { highWaterTokens: 75_000, maxOutputTokens: 160 },
      uniform: { highWaterTokens: 60_000, maxOutputTokens: 160 },
    };
  }
  return {
    "route-aware": { highWaterTokens: 75_000, maxOutputTokens: 256 },
    uniform: { highWaterTokens: 60_000, maxOutputTokens: 512 },
  };
}

function fixtureManifest(scenario) {
  const fixture = {
    chunks: scenario.chunks.map((chunk, step) => ({
      characters: chunk.text.length,
      expectedTokenCount: scenario.task(step).expected.length,
      step,
    })),
    highWaterTokens,
    scenario: scenario.id,
    steps,
    targetChunkCharacters,
  };
  return {
    ...fixture,
    fixtureSha256: createHash("sha256")
      .update(
        JSON.stringify({
          chunks: scenario.chunks,
          instructions: scenario.instructions,
          summaries: scenario.chunks.map((_, step) =>
            scenario.summary(step + 1)
          ),
          tasks: scenario.chunks.map((_, step) => scenario.task(step)),
        })
      )
      .digest("hex"),
    schemaVersion: 1,
  };
}

async function runPolicy({
  arm,
  highWaterTokensOverride,
  maxOutputTokens,
  model,
  orderIndex,
  policy,
  replicate,
  scenario,
}) {
  const effectiveHighWaterTokens = highWaterTokensOverride ?? highWaterTokens;
  const runMarker = randomUUID();
  const cacheIsolationKeySha256 = createHash("sha256")
    .update(runMarker)
    .digest("hex");
  const baseSystem = `${scenario.instructions}\n\nBenchmark run marker: ${runMarker}. Use only supplied context. Return only the requested JSON object.`;
  let messages = [{ content: baseSystem, role: "system" }];
  const records = [];
  const compactionTriggers = [];

  for (let step = 0; step < steps; step += 1) {
    const task = scenario.task(step);
    messages.push({
      content: `${scenario.chunks[step].text}\n\n=== CURRENT TASK ===\n${task.question}`,
      role: "user",
    });

    const startedAt = performance.now();
    const result = await requestModel({ maxOutputTokens, messages, model });
    const latencyMs = Math.round(performance.now() - startedAt);
    const responseText = result.text ?? "";
    const tokenRecallCorrect =
      result.ok && task.expected.every((token) => responseText.includes(token));
    const correct =
      result.ok && strictJsonMatches(responseText, task.expectedJson);
    const record = {
      attempts: result.attempts,
      cachedTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      correct,
      errorCode: result.errorCode,
      expected: task.expected,
      expectedJson: task.expectedJson,
      finishReason: result.finishReason,
      httpStatus: result.httpStatus,
      inputTokens: result.usage.inputTokens,
      latencyMs,
      requestSuccessful: result.ok,
      responseModel: result.responseModel,
      responseModelMatchesRequested: result.responseModelMatchesRequested,
      responseText,
      step,
      tokenRecallCorrect,
      usageFieldAudit: result.usage.usageFieldAudit,
      usageEnvelopeValid: validCacheUsageEnvelope(result.usage),
    };
    records.push(record);
    console.error(
      JSON.stringify({
        cachedTokens: record.cachedTokens,
        correct,
        inputTokens: record.inputTokens,
        latencyMs,
        model: model.id,
        policy: policy.name,
        scenario: scenario.id,
        status: record.httpStatus,
        step,
      })
    );

    messages.push({
      content: responseText.length > 0 ? responseText : "NO_RESPONSE_CONTENT",
      role: "assistant",
    });

    if (step >= steps - 1) {
      continue;
    }
    const currentTokens =
      record.inputTokens ?? estimateMessagesTokens(messages);
    const projectedNextTokens =
      currentTokens + scenario.chunks[step + 1].text.length / 3.2;
    const shouldCompact =
      policy.kind === "always" ||
      projectedNextTokens >= effectiveHighWaterTokens;
    if (shouldCompact) {
      compactionTriggers.push(currentTokens);
      messages = [
        { content: baseSystem, role: "system" },
        {
          content: `=== COMPACTED DURABLE STATE THROUGH STEP ${step} ===\n${scenario.summary(step + 1)}`,
          role: "system",
        },
      ];
    }
  }

  return summarizePolicyRun({
    arm,
    cacheIsolationKeySha256,
    compactionTriggers,
    effectiveHighWaterTokens,
    maxOutputTokens,
    model,
    orderIndex,
    policy,
    records,
    replicate,
  });
}

function summarizePolicyRun({
  arm,
  cacheIsolationKeySha256,
  compactionTriggers,
  effectiveHighWaterTokens,
  maxOutputTokens,
  model,
  orderIndex,
  policy,
  records,
  replicate,
}) {
  const successful = records.filter((record) => record.requestSuccessful);
  const attributedWarm = successful.filter(
    (record) => record.step > 0 && record.responseModelMatchesRequested === true
  );
  const tracked = attributedWarm.filter(
    (record) =>
      record.cachedTokens !== undefined &&
      record.inputTokens !== undefined &&
      record.usageEnvelopeValid
  );
  const trackedInputTokens = sum(tracked.map((record) => record.inputTokens));
  const trackedCacheReadTokens = sum(
    tracked.map((record) => record.cachedTokens)
  );
  const writeTracked = attributedWarm.filter(
    (record) =>
      record.cacheWriteTokens !== undefined && record.usageEnvelopeValid
  );
  const successfulInputTokens = successful.flatMap((record) =>
    record.inputTokens === undefined ? [] : [record.inputTokens]
  );

  return {
    accuracyRate: divide(
      records.filter((record) => record.correct).length,
      records.length
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
    cacheIsolationKeySha256,
    trackedCacheWriteTokens:
      writeTracked.length === 0
        ? null
        : sum(writeTracked.map((record) => record.cacheWriteTokens)),
    ...(arm === undefined ? {} : { arm }),
    compactionTriggers,
    compactions: compactionTriggers.length,
    failures: records.length - successful.length,
    highWaterTokens: effectiveHighWaterTokens,
    maxInputTokens:
      successfulInputTokens.length === 0
        ? null
        : Math.max(...successfulInputTokens),
    missingFinishReasons: successful.filter(
      (record) =>
        record.finishReason === undefined || record.finishReason === null
    ).length,
    medianLatencyMs:
      percentile(
        successful.map((record) => record.latencyMs),
        0.5
      ) ?? null,
    modelId: model.id,
    maxOutputTokens: maxOutputTokens ?? model.request.max_tokens,
    ...(orderIndex === undefined ? {} : { orderIndex }),
    p95LatencyMs:
      percentile(
        successful.map((record) => record.latencyMs),
        0.95
      ) ?? null,
    policy: policy.name,
    ...(replicate === undefined ? {} : { replicate }),
    responseModelAudit: responseModelAudit(records, model.id),
    tokenRecallRate: divide(
      records.filter((record) => record.tokenRecallCorrect).length,
      records.length
    ),
    turns: records.map(sanitizeTurn),
    telemetryCoverage:
      attributedWarm.length === 0
        ? null
        : tracked.length / attributedWarm.length,
    trackedCacheReadTokens:
      tracked.length === 0 ? null : trackedCacheReadTokens,
    trackedInputTokens: tracked.length === 0 ? null : trackedInputTokens,
    trackedRequests: tracked.length,
  };
}

function sanitizeTurn(record) {
  return {
    attempts: record.attempts,
    cacheFieldReported: record.cachedTokens !== undefined,
    cacheWriteFieldReported: record.cacheWriteTokens !== undefined,
    cacheWriteTokens: record.cacheWriteTokens ?? null,
    cachedTokens: record.cachedTokens ?? null,
    correct: record.correct,
    errorClass: classifyError(record),
    finishReason: record.finishReason ?? null,
    httpStatus: record.httpStatus ?? null,
    inputTokens: record.inputTokens ?? null,
    latencyMs: record.latencyMs,
    requestSuccessful: record.requestSuccessful,
    responseModel: record.responseModel ?? null,
    responseModelMatchesRequested: record.responseModelMatchesRequested ?? null,
    step: record.step,
    tokenRecallCorrect: record.tokenRecallCorrect,
    usageFieldAudit: record.usageFieldAudit,
    usageEnvelopeValid: record.usageEnvelopeValid,
  };
}

function classifyError(record) {
  if (!record.errorCode) {
    return null;
  }
  if (record.httpStatus === 429) {
    return "rate-limit";
  }
  if ((record.httpStatus ?? 0) >= 500) {
    return "upstream-server";
  }
  if (record.httpStatus && record.httpStatus >= 400) {
    return "http-client";
  }
  return record.errorCode;
}

async function requestModel({ maxOutputTokens, messages, model }) {
  const maximumAttempts = confirmationMode ? 1 : 2;
  let lastErrorCode = "network-or-timeout";
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        body: JSON.stringify({
          messages,
          model: model.id,
          temperature: 0.1,
          ...model.request,
          ...(maxOutputTokens === undefined
            ? {}
            : { max_tokens: maxOutputTokens }),
        }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      const json = await response.json().catch(() => undefined);
      const usage = extractUsage(json?.usage);
      if (response.ok) {
        const parsed = parseCompletionResponse(json, model.id);
        if (!parsed.ok) {
          return {
            attempts: attempt,
            errorCode: parsed.errorCode,
            httpStatus: response.status,
            ok: false,
            responseModel: parsed.responseModel,
            responseModelMatchesRequested: parsed.responseModelMatchesRequested,
            usage,
          };
        }
        return {
          attempts: attempt,
          errorCode: null,
          finishReason: parsed.finishReason,
          httpStatus: response.status,
          ok: true,
          responseModel: parsed.responseModel,
          responseModelMatchesRequested: parsed.responseModelMatchesRequested,
          text: parsed.text,
          usage,
        };
      }
      lastErrorCode = safeResponseErrorCode(json, response.status);
      if (response.status < 500 && response.status !== 429) {
        return {
          attempts: attempt,
          errorCode: lastErrorCode,
          httpStatus: response.status,
          ok: false,
          responseModel: null,
          responseModelMatchesRequested: null,
          usage,
        };
      }
    } catch {
      lastErrorCode = "network-or-timeout";
    }
    if (attempt < maximumAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  return {
    attempts: maximumAttempts,
    errorCode: lastErrorCode,
    httpStatus: null,
    ok: false,
    responseModel: null,
    responseModelMatchesRequested: null,
    usage: extractUsage(undefined),
  };
}

function buildScenario(id, root) {
  switch (id) {
    case "file-search":
      return buildFileSearchScenario(root);
    case "conversation":
      return buildConversationScenario();
    case "deep-research":
      return buildResearchScenario();
    default:
      throw new Error(
        "scenario must be file-search, conversation, or deep-research"
      );
  }
}

function resolveRepoRoot(input) {
  const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const candidate = input ? resolve(process.cwd(), input) : defaultRoot;
  if (existsSync(join(candidate, "packages/runtime/src"))) {
    const realCandidate = realpathSync(candidate);
    const sourceRoot = join(realCandidate, "packages/runtime/src");
    if (lstatSync(sourceRoot).isDirectory()) {
      return realCandidate;
    }
  }
  if (input === "." && existsSync(join(defaultRoot, "packages/runtime/src"))) {
    return realpathSync(defaultRoot);
  }
  throw new Error(
    `repository root must contain packages/runtime/src: ${candidate}`
  );
}

function buildFileSearchScenario(root) {
  const sourceRoot = realpathSync(join(root, "packages/runtime/src"));
  const files = listFiles(sourceRoot, sourceRoot)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.includes("/fixtures/")
    )
    .map((file) => {
      const content = readFileSync(file, "utf8");
      return {
        content,
        exports: exportedSymbols(content),
        path: relative(root, file),
      };
    })
    .filter((file) => file.content.length > 0);

  const batches = [];
  let cursor = 0;
  while (batches.length < steps && cursor < files.length) {
    const entries = [];
    let characters = 0;
    while (cursor < files.length && characters < targetChunkCharacters) {
      const file = files[cursor];
      cursor += 1;
      entries.push(file);
      characters += file.content.length;
    }
    const mappings = entries.flatMap((file) =>
      file.exports.map((symbol) => ({ path: file.path, symbol }))
    );
    if (mappings.length === 0) {
      continue;
    }
    batches.push({
      mappings,
      target: mappings[Math.min(mappings.length - 1, batches.length * 3)],
      text: entries
        .map(
          (file) =>
            `=== FILE ${file.path} ===\n${file.content}\n=== END FILE ${file.path} ===`
        )
        .join("\n\n"),
    });
  }
  if (batches.length < steps) {
    throw new Error(`only built ${batches.length} file-search chunks`);
  }
  const targetSchedule = [0, 0, 1, 0, 2, 0];
  return {
    chunks: batches,
    id: "file-search",
    instructions:
      "You are searching a large TypeScript repository snapshot. FILE headers are authoritative. Locate the file that defines the requested exported symbol; do not guess from import sites.",
    summary: (seenCount) =>
      ["Export index from compacted files:"]
        .concat(
          batches
            .slice(0, seenCount)
            .flatMap((batch) => batch.mappings)
            .map(({ path, symbol }) => `${symbol} -> ${path}`)
        )
        .join("\n"),
    task: (step) => {
      const target = batches[targetSchedule[step]].target;
      return {
        expected: [target.path],
        expectedJson: { path: target.path },
        question: `Which FILE defines the exported symbol ${target.symbol}? Return exactly {"path":"<repo-relative path>"}.`,
      };
    },
  };
}

function buildConversationScenario() {
  const primaryUpdates = new Map([
    [0, { id: "DECISION-ORION-000", value: "owner-amber" }],
    [2, { id: "DECISION-ORION-002", value: "owner-cobalt" }],
    [4, { id: "DECISION-ORION-004", value: "owner-ember" }],
  ]);
  const chunks = Array.from({ length: steps }, (_, step) => {
    const lines = [];
    const update = primaryUpdates.get(step);
    for (
      let line = 0;
      lines.join("\n").length < targetChunkCharacters;
      line += 1
    ) {
      if (line === 137 && update) {
        lines.push(
          `[2026-07-${String(step + 10).padStart(2, "0")} 14:00] ${update.id}: The team explicitly CONFIRMED project-orion.deployment-owner = ${update.value}. This supersedes every older owner value.`
        );
        continue;
      }
      const project = `project-${String((line * 7 + step) % 53).padStart(2, "0")}`;
      const person = `member-${String((line * 11 + step * 3) % 97).padStart(2, "0")}`;
      lines.push(
        `[2026-07-${String(step + 10).padStart(2, "0")} ${String(line % 24).padStart(2, "0")}:${String((line * 13) % 60).padStart(2, "0")}] Conversation ${step}-${line}: ${person} discussed ${project}, rollout cohort ${line % 17}, dashboard filter ${line % 23}, and a non-authoritative owner suggestion member-${(line + 19) % 97}. No change was confirmed.`
      );
    }
    return { text: `=== CONVERSATION BLOCK ${step} ===\n${lines.join("\n")}` };
  });
  const latestUpdate = (seenCount) => {
    let latest;
    for (let step = 0; step < seenCount; step += 1) {
      latest = primaryUpdates.get(step) ?? latest;
    }
    return latest;
  };
  return {
    chunks,
    id: "conversation",
    instructions:
      "You maintain durable facts from a very long project conversation. Only explicit CONFIRMED decisions change a value, and a newer confirmation supersedes older values. Suggestions do not change state.",
    summary: (seenCount) => {
      const latest = latestUpdate(seenCount);
      return `Current confirmed state:\nproject-orion.deployment-owner = ${latest.value}\nEvidence = ${latest.id}\nAll later unconfirmed suggestions are non-authoritative.`;
    },
    task: (step) => {
      const latest = latestUpdate(step + 1);
      return {
        expected: [latest.value, latest.id],
        expectedJson: { evidence: latest.id, value: latest.value },
        question:
          'What is the latest confirmed value of project-orion.deployment-owner and which decision established it? Return exactly {"value":"...","evidence":"..."}.',
      };
    },
  };
}

function buildResearchScenario() {
  const orionRecords = [
    {
      date: "2026-01-10",
      id: "SRC-ORION-001",
      kind: "primary",
      result: "EFF-71",
      status: "active",
    },
    {
      date: "2026-02-18",
      id: "SRC-ORION-002",
      kind: "secondary",
      result: "EFF-88",
      status: "active",
    },
    {
      date: "2026-03-22",
      id: "SRC-ORION-003",
      kind: "primary",
      result: "EFF-74",
      status: "active",
    },
    {
      date: "2026-04-19",
      id: "SRC-ORION-004",
      kind: "primary",
      result: "EFF-99",
      status: "retracted",
    },
    {
      date: "2026-05-27",
      id: "SRC-ORION-005",
      kind: "primary",
      result: "EFF-77",
      status: "active",
    },
    {
      date: "2026-06-30",
      id: "SRC-ORION-006",
      kind: "secondary",
      result: "EFF-80",
      status: "active",
    },
  ];
  const chunks = orionRecords.map((orion, step) => {
    const lines = [researchRecord("ORION", orion)];
    for (
      let index = 0;
      lines.join("\n").length < targetChunkCharacters;
      index += 1
    ) {
      const record = {
        date: `2026-${String((index % 12) + 1).padStart(2, "0")}-${String(((index * 7) % 28) + 1).padStart(2, "0")}`,
        id: `SRC-${String(step).padStart(2, "0")}-${String(index).padStart(4, "0")}`,
        kind: index % 3 === 0 ? "primary" : "secondary",
        result: `EFF-${String((index * 17 + step * 5) % 100).padStart(2, "0")}`,
        status: index % 19 === 0 ? "retracted" : "active",
      };
      lines.push(researchRecord(`TOPIC-${(index + step) % 41}`, record));
    }
    return {
      text: `=== RESEARCH SOURCE BATCH ${step} ===\n${lines.join("\n")}`,
    };
  });
  const bestRecord = (seenCount) =>
    orionRecords
      .slice(0, seenCount)
      .filter(
        (record) => record.kind === "primary" && record.status === "active"
      )
      .sort((left, right) => right.date.localeCompare(left.date))[0];
  return {
    chunks,
    id: "deep-research",
    instructions:
      "You synthesize a large research corpus. For each topic, select the most recent source that is both primary and active. Secondary or retracted sources must never win, even when newer or numerically larger.",
    summary: (seenCount) => {
      const seen = orionRecords.slice(0, seenCount);
      const best = bestRecord(seenCount);
      return [
        "ORION evidence ledger:",
        ...seen.map(
          (record) =>
            `${record.id} date=${record.date} kind=${record.kind} status=${record.status} result=${record.result}`
        ),
        `Current valid winner: ${best.id} result=${best.result}`,
      ].join("\n");
    },
    task: (step) => {
      const best = bestRecord(step + 1);
      return {
        expected: [best.id, best.result],
        expectedJson: { result: best.result, source_id: best.id },
        question:
          'For ORION, identify the most recent active primary source and its result. Return exactly {"source_id":"...","result":"..."}.',
      };
    },
  };
}

function researchRecord(topic, record) {
  return `[RESEARCH RECORD] topic=${topic}; source_id=${record.id}; published=${record.date}; source_type=${record.kind}; status=${record.status}; result=${record.result}. Editorial note: apply source type, status, and date rules before comparing results.`;
}

function listFiles(directory, containmentRoot) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        return [];
      }
      if (stat.isDirectory()) {
        const realDirectory = realpathSync(path);
        return isContainedPath(containmentRoot, realDirectory)
          ? listFiles(realDirectory, containmentRoot)
          : [];
      }
      if (!stat.isFile()) {
        return [];
      }
      const realFile = realpathSync(path);
      return isContainedPath(containmentRoot, realFile) ? [realFile] : [];
    });
}

function isContainedPath(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function exportedSymbols(source) {
  const symbols = [];
  const pattern =
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) {
      symbols.push(match[1]);
    }
  }
  return [...new Set(symbols)];
}

function extractUsage(usage) {
  const cacheRead = auditedNumber(usage, CACHE_READ_PATHS);
  const cacheWrite = auditedNumber(usage, CACHE_WRITE_PATHS);
  const input = auditedNumber(usage, INPUT_PATHS);
  return {
    cacheReadTokens: cacheRead.value,
    cacheWriteTokens: cacheWrite.value,
    inputTokens: input.value,
    usageFieldAudit: {
      cacheRead: cacheRead.status,
      cacheWrite: cacheWrite.status,
      input: input.status,
    },
  };
}

function validCacheUsageEnvelope(usage) {
  if (
    usage.usageFieldAudit.input !== "valid" ||
    !isSafeTokenCount(usage.inputTokens)
  ) {
    return false;
  }
  const read = usage.cacheReadTokens;
  const write = usage.cacheWriteTokens;
  if (
    (read !== undefined && read > usage.inputTokens) ||
    (write !== undefined && write > usage.inputTokens) ||
    (read !== undefined &&
      write !== undefined &&
      read + write > usage.inputTokens)
  ) {
    return false;
  }
  return (
    (usage.usageFieldAudit.cacheRead === "absent" ||
      usage.usageFieldAudit.cacheRead === "valid") &&
    (usage.usageFieldAudit.cacheWrite === "absent" ||
      usage.usageFieldAudit.cacheWrite === "valid")
  );
}

function auditedNumber(input, paths) {
  const present = paths.flatMap((path) => {
    const observed = valueAtPath(input, path);
    return observed.present ? [observed.value] : [];
  });
  if (present.length === 0) {
    return { status: "absent", value: undefined };
  }
  if (present.some((value) => !isSafeTokenCount(value))) {
    return { status: "invalid", value: undefined };
  }
  const unique = new Set(present);
  if (unique.size !== 1) {
    return { status: "conflict", value: undefined };
  }
  return { status: "valid", value: present[0] };
}

function valueAtPath(input, path) {
  let current = input;
  for (const segment of path.split(".")) {
    if (
      !(
        current &&
        typeof current === "object" &&
        Object.hasOwn(current, segment)
      )
    ) {
      return { present: false, value: undefined };
    }
    current = current[segment];
  }
  return { present: true, value: current };
}

function isSafeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeResponseErrorCode(body, status) {
  const error = body && typeof body === "object" ? body.error : undefined;
  if (error && typeof error === "object") {
    for (const candidate of [error.code, error.type]) {
      if (
        typeof candidate === "string" &&
        SAFE_ERROR_CODE_PATTERN.test(candidate)
      ) {
        return candidate;
      }
    }
  }
  return `http-${status}`;
}

function strictJsonMatches(text, expected) {
  if (typeof text !== "string") {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return false;
  }
  if (
    !(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.getPrototypeOf(parsed) === Object.prototype
    )
  ) {
    return false;
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(parsed).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => parsed[key] === expected[key])
  );
}

function responseModelAudit(records, requestedModel) {
  const observed = new Map();
  for (const record of records) {
    if (record.responseModel !== undefined && record.responseModel !== null) {
      observed.set(
        record.responseModel,
        (observed.get(record.responseModel) ?? 0) + 1
      );
    }
  }
  return {
    exactRequestedModel: records.filter(
      (record) => record.responseModelMatchesRequested === true
    ).length,
    mismatched: records.filter(
      (record) => record.responseModelMatchesRequested === false
    ).length,
    missingOrInvalid: records.filter(
      (record) => record.responseModelMatchesRequested === null
    ).length,
    observedModels: Object.fromEntries(observed),
    requestedModel,
    turns: records.length,
  };
}

function estimateMessagesTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
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
  return values.reduce((total, value) => total + value, 0);
}

function sourceManifest(entries) {
  const files = entries.map(([path, url]) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(url)).digest("hex"),
  }));
  return {
    files,
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
  };
}

function csvEnv(name) {
  const value = process.env[name]?.trim();
  return value
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

function positiveIntegerEnv(name, fallback, maximum) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!(Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum)) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}`
    );
  }
  return parsed;
}

await main();
