import type { LanguageModel } from "ai";
import { runAgent } from "./harness";
import { deepEqual } from "./matchers";
import { createJudgeScope } from "./scope-judge";
import {
  isPromise,
  outputEqualsFailure,
  parseReply,
  truncate,
} from "./scope-output";
import { handleFor, type MutableRecord } from "./scope-records";
import { isMatchingCall } from "./scope-tool-matching";
import type {
  AgentEvent,
  AssertionHandle,
  AssertionRecord,
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
  readonly #records: MutableRecord[] = [];

  constructor(thread: EvalThreadLike, judgeModel?: () => LanguageModel) {
    this.#thread = thread;
    this.#judgeModel = judgeModel;
  }

  get reply(): string { return this.#runs.at(-1)?.output ?? ""; }

  get events(): readonly AgentEvent[] { return this.#runs.flatMap((r) => r.events); }

  get toolCalls(): readonly EvalToolCall[] { return this.#runs.flatMap((r) => r.toolCalls); }

  get toolResults(): readonly EvalToolResult[] { return this.#runs.flatMap((r) => r.toolResults); }

  get failed(): boolean { return this.#runs.some((r) => r.error !== undefined); }

  get records(): readonly AssertionRecord[] { return this.#records; }

  get runs(): readonly EvalRun[] { return this.#runs; }

  async run(input: string): Promise<EvalRun> {
    const result = await runAgent(this.#thread, input);
    this.#runs.push(result);
    return result;
  }

  // --- run-level assertions ---

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
    const entry: MutableRecord = {
      failure: pass ? undefined : failure,
      label,
      passed: pass,
      score,
      severity,
      strictOnly: severity === "soft",
    };
    this.#records.push(entry);
    return handleFor(entry);
  }

  /** Record a deferred judge assertion; the runner resolves it after the test. */
  recordPending(
    label: string,
    severity: AssertionRecord["severity"],
    resolve: NonNullable<MutableRecord["resolve"]>
  ): AssertionHandle {
    const entry: MutableRecord = {
      label,
      passed: true,
      resolve,
      severity,
      strictOnly: severity === "soft",
    };
    this.#records.push(entry);
    return handleFor(entry);
  }

  /** Resolve all deferred judge assertions in place. */
  async resolvePending(): Promise<void> {
    for (const entry of this.#records) {
      if (!entry.resolve) {
        continue;
      }
      const verdict = await entry.resolve();
      entry.resolve = undefined;
      entry.score = verdict.score;
      entry.failure = verdict.reason;
      entry.passed =
        entry.threshold === undefined
          ? verdict.pass
          : verdict.score >= entry.threshold;
    }
  }
}
