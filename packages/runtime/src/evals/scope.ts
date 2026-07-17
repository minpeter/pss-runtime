import type { LanguageModel } from "ai";
import { summarizeCacheUsage } from "./cache";
import { runAgent } from "./harness";
import { deepEqual } from "./matchers";
import { createJudgeScope } from "./scope-judge";
import {
  isPromise,
  outputEqualsFailure,
  parseReply,
  truncate,
} from "./scope-output";
import {
  AssertionRecorder,
  type PendingRecordResolver,
} from "./scope-recorder";
import { isMatchingCall } from "./scope-tool-matching";
import type {
  AgentEvent,
  AssertionHandle,
  AssertionRecord,
  CacheHitRateOptions,
  EvalCacheStats,
  EvalRun,
  EvalScope,
  EvalThreadLike,
  EvalToolCall,
  EvalToolResult,
  SchemaInput,
  ToolCallMatcherOptions,
  ValueBuilder,
} from "./types";

/**
 * The recording scope. Every assertion pushes a result onto `records` and
 * returns a severity handle; nothing throws, so a single run reports every
 * failing assertion (eve-style multi-verdict). The runner reads `records` to
 * compute the verdict.
 */
export class EvalScopeImpl implements EvalScope {
  readonly #thread: EvalThreadLike;
  readonly #judgeModel: (() => LanguageModel) | undefined;
  readonly #runs: EvalRun[] = [];
  readonly #recorder = new AssertionRecorder();

  constructor(thread: EvalThreadLike, judgeModel?: () => LanguageModel) {
    this.#thread = thread;
    this.#judgeModel = judgeModel;
  }

  get reply(): string {
    return this.#runs.at(-1)?.output ?? "";
  }

  get cache(): EvalCacheStats {
    return summarizeCacheUsage(this.#runs.flatMap((run) => run.modelUsage));
  }

  get events(): readonly AgentEvent[] {
    return this.#runs.flatMap((r) => r.events);
  }

  get toolCalls(): readonly EvalToolCall[] {
    return this.#runs.flatMap((r) => r.toolCalls);
  }

  get toolResults(): readonly EvalToolResult[] {
    return this.#runs.flatMap((r) => r.toolResults);
  }

  get failed(): boolean {
    return this.#runs.some((r) => r.error !== undefined);
  }

  get records(): readonly AssertionRecord[] {
    return this.#recorder.records;
  }

  get runs(): readonly EvalRun[] {
    return this.#runs;
  }

  async run(input: string): Promise<EvalRun> {
    const result = await runAgent(this.#thread, input);
    this.#runs.push(result);
    return result;
  }

  // --- run-level assertions ---

  cacheHitRateAtLeast(
    minimum: number,
    options: CacheHitRateOptions = {}
  ): AssertionHandle {
    assertRate(minimum);
    const warmupRuns = options.warmupRuns ?? 0;
    const minTrackedRequests = options.minTrackedRequests ?? 1;
    const minTelemetryCoverage = options.minTelemetryCoverage ?? 0;
    assertNonNegativeInteger("warmupRuns", warmupRuns);
    assertNonNegativeInteger("minTrackedRequests", minTrackedRequests);
    assertRate(minTelemetryCoverage, "minTelemetryCoverage");

    const cache = summarizeCacheUsage(
      this.#runs.slice(warmupRuns).flatMap((run) => run.modelUsage)
    );
    const rate = cache.cacheHitRate;
    const enoughRequests = cache.trackedRequests >= minTrackedRequests;
    const enoughCoverage =
      cache.telemetryCoverage !== undefined &&
      cache.telemetryCoverage >= minTelemetryCoverage;
    const pass =
      rate !== undefined && enoughRequests && enoughCoverage && rate >= minimum;
    const detail = cacheHitRateFailure({
      cache,
      enoughCoverage,
      enoughRequests,
      minTelemetryCoverage,
      minTrackedRequests,
      minimum,
      rate,
    });
    return this.record(
      `cacheHitRateAtLeast(${minimum})`,
      "gate",
      pass,
      pass ? undefined : detail,
      rate
    );
  }

  completed(): AssertionHandle {
    return this.record("completed", "gate", !this.failed);
  }

  didNotFail(): AssertionHandle {
    return this.record("didNotFail", "gate", !this.failed);
  }

  messageIncludes(token: string | RegExp): AssertionHandle {
    const text = this.reply;
    const pass =
      token instanceof RegExp ? token.test(text) : text.includes(token);
    return this.record(
      `messageIncludes(${String(token)})`,
      "gate",
      pass,
      pass ? undefined : `reply was ${JSON.stringify(truncate(text))}`
    );
  }

  calledTool(
    name: string,
    options: ToolCallMatcherOptions = {}
  ): AssertionHandle {
    const matches = this.toolCalls.filter((call) =>
      isMatchingCall(call, this.#runs, name, options)
    );
    const wanted = options.times;
    const pass =
      wanted === undefined ? matches.length >= 1 : matches.length === wanted;
    const detail = pass
      ? undefined
      : `called ${matches.length} matching ${name}(s); calls: [${this.toolCalls.map((c) => c.toolName).join(", ")}]`;
    return this.record(`calledTool(${name})`, "gate", pass, detail);
  }

  notCalledTool(name: string): AssertionHandle {
    const count = this.toolCalls.filter((c) => c.toolName === name).length;
    return this.record(
      `notCalledTool(${name})`,
      "gate",
      count === 0,
      count > 0 ? `called ${name} ${count}x` : undefined
    );
  }

  toolOrder(names: readonly string[]): AssertionHandle {
    const order = this.toolCalls.map((c) => c.toolName);
    let matched = 0;
    for (const called of order) {
      if (matched < names.length && called === names[matched]) {
        matched++;
      }
    }
    const pass = matched === names.length;
    return this.record(
      `toolOrder([${names.join(" -> ")}])`,
      "gate",
      pass,
      pass
        ? undefined
        : `[${order.join(", ")}] stopped at ${names[matched] ?? "?"}`
    );
  }

  usedNoTools(): AssertionHandle {
    const pass = this.toolCalls.length === 0;
    return this.record(
      "usedNoTools",
      "gate",
      pass,
      pass ? undefined : `called ${this.toolCalls.length} tool(s)`
    );
  }

  maxToolCalls(n: number): AssertionHandle {
    const pass = this.toolCalls.length <= n;
    return this.record(
      `maxToolCalls(${n})`,
      "gate",
      pass,
      pass ? undefined : `called ${this.toolCalls.length} (> ${n})`
    );
  }

  noFailedActions(): AssertionHandle {
    const errored = this.events.filter((e) => e.type === "turn-error").length;
    return this.record(
      "noFailedActions",
      "gate",
      errored === 0,
      errored > 0 ? `${errored} turn-error event(s)` : undefined
    );
  }

  event(
    predicate: (events: readonly AgentEvent[]) => boolean,
    label: string
  ): AssertionHandle {
    return this.record(`event(${label})`, "gate", predicate(this.events));
  }

  outputEquals(value: unknown): AssertionHandle {
    const parsed = parseReply(this.reply);
    const pass = parsed.ok && deepEqual(parsed.value, value);
    return this.record(
      "outputEquals",
      "gate",
      pass,
      outputEqualsFailure(parsed.ok)
    );
  }

  outputMatches(schema: SchemaInput): AssertionHandle {
    const parsed = parseReply(this.reply);
    if (!parsed.ok) {
      return this.record("outputMatches", "gate", false, "reply was not JSON");
    }
    const result = schema["~standard"].validate(parsed.value);
    if (isPromise(result)) {
      throw new TypeError("outputMatches(): async schemas are not supported");
    }
    const issues = result.issues;
    const pass = !issues || issues.length === 0;
    return this.record(
      "outputMatches",
      "gate",
      pass,
      pass ? undefined : (issues?.[0]?.message ?? "schema rejected reply")
    );
  }

  check<T>(value: T, builder: ValueBuilder<T>): AssertionHandle {
    const { pass, score, detail } = builder.score(value);
    return this.record(
      builder.label,
      builder.defaultSeverity,
      pass,
      detail,
      score
    );
  }

  get judge(): EvalScope["judge"] {
    return createJudgeScope({
      judgeModel: this.#judgeModel,
      recordPending: (label, severity, resolve) =>
        this.recordPending(label, severity, resolve),
      reply: () => this.reply,
    });
  }

  // --- recording core ---

  record(
    label: string,
    severity: AssertionRecord["severity"],
    pass: boolean,
    failure?: string,
    score?: number
  ): AssertionHandle {
    return this.#recorder.record(label, severity, pass, failure, score);
  }

  /** Record a deferred judge assertion; the runner resolves it after the test. */
  recordPending(
    label: string,
    severity: AssertionRecord["severity"],
    resolve: PendingRecordResolver
  ): AssertionHandle {
    return this.#recorder.recordPending(label, severity, resolve);
  }

  /** Resolve all deferred judge assertions in place. */
  async resolvePending(): Promise<void> {
    await this.#recorder.resolvePending();
  }
}

function assertRate(value: number, name = "cache hit rate"): void {
  if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!(Number.isInteger(value) && value >= 0)) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function cacheHitRateFailure({
  cache,
  enoughCoverage,
  enoughRequests,
  minTelemetryCoverage,
  minTrackedRequests,
  minimum,
  rate,
}: {
  readonly cache: EvalCacheStats;
  readonly enoughCoverage: boolean;
  readonly enoughRequests: boolean;
  readonly minTelemetryCoverage: number;
  readonly minTrackedRequests: number;
  readonly minimum: number;
  readonly rate: number | undefined;
}): string {
  if (!enoughRequests) {
    return `provider cache usage tracked for ${cache.trackedRequests} request(s); expected at least ${minTrackedRequests}`;
  }
  if (!enoughCoverage) {
    const observed = cache.telemetryCoverage;
    return observed === undefined
      ? `provider cache telemetry coverage was unavailable; expected at least ${minTelemetryCoverage.toFixed(4)}`
      : `provider cache telemetry coverage ${observed.toFixed(4)} was below ${minTelemetryCoverage.toFixed(4)} (${cache.trackedRequests}/${cache.requests} requests)`;
  }
  if (rate === undefined) {
    if (
      cache.trackedRequests > 0 &&
      cache.trackedInputTokens === undefined &&
      cache.trackedCacheReadTokens === undefined
    ) {
      return "provider-reported paired token totals exceeded the safe integer range";
    }
    return cache.trackedInputTokens === 0
      ? "provider-reported tracked input token total was zero"
      : "provider did not report cache-read and input token counts";
  }
  return `cache hit rate ${rate.toFixed(4)} was below ${minimum.toFixed(4)} (${cache.trackedCacheReadTokens}/${cache.trackedInputTokens} tokens)`;
}
