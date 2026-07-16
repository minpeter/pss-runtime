import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent, type ModelUsage } from "@minpeter/pss-runtime";
import {
  type EvalCacheStats,
  runAgent,
  summarizeCacheUsage,
} from "@minpeter/pss-runtime/evals";

const ADAPTER = "@ai-sdk/openai-compatible@3.0.2";
const ADAPTER_CACHE_BOUNDARY =
  "When raw prompt_tokens_details.cached_tokens is omitted, this adapter normalizes it to zero. A normalized zero therefore does not prove that the upstream provider explicitly reported zero.";

interface LiveTurnResult {
  readonly attempts: readonly (ModelUsage & { readonly attempt: number })[];
  readonly turn: number;
  readonly wallDurationMs: number;
}

interface LiveModelResult {
  readonly cacheClassification:
    | "N/A (not reported)"
    | "adapter-zero-ambiguous"
    | "reported-nonzero";
  readonly cacheSteadyState: EvalCacheStats;
  readonly cacheWithWarmup: EvalCacheStats;
  readonly modelId: string;
  readonly turns: readonly LiveTurnResult[];
}

async function main(): Promise<void> {
  const apiKey = requiredEnv("FREEROUTER_API_KEY");
  const baseURL = publicBaseUrl(requiredEnv("FREEROUTER_BASE_URL"));
  const modelIds = [
    ...new Set(
      process.argv
        .slice(2)
        .filter((argument) => argument !== "--")
        .map((argument) => argument.trim())
        .filter(Boolean)
    ),
  ];
  if (modelIds.length === 0) {
    throw new Error("pass at least one model id");
  }

  const turns = integerEnv("PSS_CACHE_BENCH_TURNS", 5, 2);
  const warmupRuns = integerEnv("PSS_CACHE_BENCH_WARMUP_RUNS", 1, 0);
  const prefixLines = integerEnv("PSS_CACHE_BENCH_PREFIX_LINES", 180, 1);
  const maxOutputTokens = integerEnv("PSS_CACHE_BENCH_MAX_OUTPUT_TOKENS", 8, 1);
  if (warmupRuns >= turns) {
    throw new Error("PSS_CACHE_BENCH_WARMUP_RUNS must be less than turns");
  }

  const provider = createOpenAICompatible({
    apiKey,
    baseURL,
    name: "freerouter-live-cache",
    transformRequestBody: (body) => ({
      ...body,
      max_tokens: maxOutputTokens,
      temperature: 0.1,
    }),
  });
  const models: LiveModelResult[] = [];
  for (const modelId of modelIds) {
    models.push(
      await runModel({ modelId, prefixLines, provider, turns, warmupRuns })
    );
  }

  const report = {
    adapter: ADAPTER,
    adapterCacheBoundary: ADAPTER_CACHE_BOUNDARY,
    configuration: {
      maxOutputTokens,
      models: modelIds,
      prefixLines,
      turns,
      warmupRuns,
    },
    credentialRecorded: false,
    endpoint: baseURL,
    generatedAt: new Date().toISOString(),
    models,
    schemaVersion: 1,
  } as const;
  const serialized = JSON.stringify(report, null, 2);
  if (serialized.includes(apiKey)) {
    throw new Error("refusing to print a report containing the credential");
  }
  process.stdout.write(`${serialized}\n`);
}

async function runModel({
  modelId,
  prefixLines,
  provider,
  turns,
  warmupRuns,
}: {
  readonly modelId: string;
  readonly prefixLines: number;
  readonly provider: ReturnType<typeof createOpenAICompatible>;
  readonly turns: number;
  readonly warmupRuns: number;
}): Promise<LiveModelResult> {
  const marker = randomUUID();
  const instructions = Array.from(
    { length: prefixLines },
    (_, index) =>
      `Runtime cache trace ${String(index).padStart(4, "0")} ${marker}: preserve this stable prefix across turns.`
  ).join("\n");
  const agent = await createAgent({
    instructions,
    model: provider(modelId),
  });
  const results: LiveTurnResult[] = [];

  try {
    for (let turn = 0; turn < turns; turn += 1) {
      const startedAt = performance.now();
      const run = await runAgent(agent, `Step ${turn}: reply with exactly OK.`);
      const wallDurationMs = Math.round(performance.now() - startedAt);
      if (run.error) {
        throw new Error(`model ${modelId} failed on turn ${turn}`);
      }
      results.push({
        attempts: run.modelUsage.map(metadataOnlyUsage),
        turn,
        wallDurationMs,
      });
    }
  } finally {
    await agent.dispose();
  }

  const allUsage = results.flatMap((result) => result.attempts);
  const steadyStateUsage = results
    .slice(warmupRuns)
    .flatMap((result) => result.attempts);
  const cacheSteadyState = summarizeCacheUsage(steadyStateUsage);
  return {
    cacheClassification: classifyCache(cacheSteadyState),
    cacheSteadyState,
    cacheWithWarmup: summarizeCacheUsage(allUsage),
    modelId,
    turns: results,
  };
}

function classifyCache(
  cache: EvalCacheStats
): LiveModelResult["cacheClassification"] {
  if (cache.trackedRequests === 0) {
    return "N/A (not reported)";
  }
  return (cache.cacheReadTokens ?? 0) > 0
    ? "reported-nonzero"
    : "adapter-zero-ambiguous";
}

function metadataOnlyUsage(
  usage: ModelUsage,
  attempt: number
): ModelUsage & { readonly attempt: number } {
  const {
    cacheReadTokens,
    cacheWriteTokens,
    durationMs,
    finishReason,
    inputTokens,
    modelId,
    noCacheTokens,
    outputTokens,
    provider,
    reasoningTokens,
    totalTokens,
    type,
  } = usage;
  return {
    attempt,
    cacheReadTokens,
    cacheWriteTokens,
    durationMs,
    finishReason,
    inputTokens,
    modelId,
    noCacheTokens,
    outputTokens,
    provider,
    reasoningTokens,
    totalTokens,
    type,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function publicBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("FREEROUTER_BASE_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "FREEROUTER_BASE_URL must not contain credentials, a query, or a fragment"
    );
  }
  const serialized = url.toString();
  return serialized.endsWith("/") ? serialized.slice(0, -1) : serialized;
}

main().catch((error: unknown) => {
  const secret = process.env.FREEROUTER_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${secret ? message.replaceAll(secret, "[REDACTED]") : message}\n`
  );
  process.exitCode = 1;
});
