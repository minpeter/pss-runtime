import { runAgent } from "./harness";
import { deepEqual, matchField } from "./matchers";
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
  readonly #runs: EvalRun[] = [];
  readonly #records: AssertionRecord[] = [];

  constructor(thread: EvalThreadLike) {
    this.#thread = thread;
  }

  get reply(): string {
    return this.#runs.at(-1)?.output ?? "";
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
    return this.#records;
  }

  run(input: string): Promise<EvalRun> {
    const run = runAgent(this.#thread, input).then((result) => {
      this.#runs.push(result);
      return result;
    });
    return run;
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
    const pass = predicate(this.events);
    return this.record(`event(${label})`, "gate", pass);
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
}

function isMatchingCall(
  call: EvalToolCall,
  runs: readonly EvalRun[],
  name: string,
  options: ToolCallMatcherOptions
): boolean {
  if (call.toolName !== name) {
    return false;
  }
  if (options.input !== undefined && !matchField(options.input, call.input)) {
    return false;
  }
  if (options.output !== undefined) {
    const result = runs
      .flatMap((r) => r.toolResults)
      .find((r) => r.toolCallId === call.toolCallId);
    if (!(result && matchField(options.output, result.output))) {
      return false;
    }
  }
  return true;
}

function parseReply(
  reply: string
): { ok: true; value: unknown } | { ok: false } {
  if (reply.length === 0) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(reply) };
  } catch {
    return { ok: false };
  }
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

function outputEqualsFailure(parsedOk: boolean): string | undefined {
  if (parsedOk) {
    return "parsed reply did not equal expected";
  }
  return "reply was not JSON";
}

interface MutableRecord {
  label: string;
  severity: AssertionRecord["severity"];
  passed: boolean;
  score?: number;
  threshold?: number;
  failure?: string;
  strictOnly: boolean;
}

function handleFor(entry: MutableRecord): AssertionHandle {
  const build = (): AssertionHandle => ({
    gate: () => {
      entry.severity = "gate";
      entry.strictOnly = false;
      return build();
    },
    soft: (threshold) => {
      entry.severity = "soft";
      entry.strictOnly = true;
      entry.threshold = threshold;
      entry.passed =
        threshold === undefined ? true : (entry.score ?? 0) >= threshold;
      return build();
    },
    atLeast: (threshold) => {
      entry.severity = "soft";
      entry.strictOnly = true;
      entry.threshold = threshold;
      entry.passed = (entry.score ?? 0) >= threshold;
      return build();
    },
  });
  return build();
}
