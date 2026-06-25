import type { EvalRun } from "./types";

/**
 * Thrown when an eval assertion fails. The runner catches these to mark a case
 * failed while preserving the message for the report.
 */
export class EvalAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalAssertionError";
  }
}

function fail(message: string): never {
  throw new EvalAssertionError(message);
}

function isEvalRun(value: unknown): value is EvalRun {
  return (
    typeof value === "object" &&
    value !== null &&
    "toolCalls" in value &&
    "output" in value
  );
}

function requireRun(value: unknown): EvalRun {
  if (!isEvalRun(value)) {
    fail("matcher expected an EvalRun (use runAgent to produce one)");
  }
  return value;
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isEvalRun(value)) {
    return value.output;
  }
  fail("text matcher expected a string or EvalRun");
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `output ${JSON.stringify(truncate(value))}`;
  }
  if (isEvalRun(value)) {
    return `run (tools: [${value.toolCalls.map((c) => c.toolName).join(", ")}])`;
  }
  return String(value);
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) {
    return false;
  }
  return ka.every(
    (k) =>
      k in (b as Record<string, unknown>) &&
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      )
  );
}

function flip(negated: boolean, ok: boolean): boolean {
  return negated ? !ok : ok;
}

function assertCalledTools(
  actual: unknown,
  names: readonly string[],
  options: { readonly ordered?: boolean } | undefined,
  negated: boolean
): void {
  const run = requireRun(actual);
  const called = run.toolCalls.map((c) => c.toolName);
  if (negated) {
    assertNoForbidden(called, names);
    return;
  }
  if (options?.ordered) {
    assertOrdered(called, names);
    return;
  }
  const missing = names.filter((n) => !called.includes(n));
  if (missing.length > 0) {
    fail(
      `expected run to call [${names.join(", ")}], missing: [${missing.join(", ")}]; actual calls: [${called.join(", ")}]`
    );
  }
}

function assertNoForbidden(
  called: readonly string[],
  names: readonly string[]
): void {
  const forbidden = names.filter((n) => called.includes(n));
  if (forbidden.length > 0) {
    fail(
      `expected run NOT to call [${names.join(", ")}], but called [${forbidden.join(", ")}]; full calls: [${called.join(", ")}]`
    );
  }
}

function assertOrdered(
  called: readonly string[],
  names: readonly string[]
): void {
  let matched = 0;
  for (const name of called) {
    if (matched < names.length && name === names[matched]) {
      matched++;
    }
  }
  if (matched < names.length) {
    fail(
      `expected tool order [${names.join(" -> ")}] as subsequence of [${called.join(", ")}]; stopped at "${names[matched]}"`
    );
  }
}

function assertContains(
  actual: unknown,
  substring: string,
  negated: boolean
): void {
  const ok = textOf(actual).includes(substring);
  if (!flip(negated, ok)) {
    fail(
      `expected ${describeValue(actual)} ${negated ? "not " : ""}to contain ${JSON.stringify(substring)}`
    );
  }
}

function assertMatch(actual: unknown, pattern: RegExp, negated: boolean): void {
  const ok = pattern.test(textOf(actual));
  if (!flip(negated, ok)) {
    fail(
      `expected ${describeValue(actual)} ${negated ? "not " : ""}to match ${pattern}`
    );
  }
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  negated: boolean
): void {
  const ok = deepEqual(actual, expected);
  if (!flip(negated, ok)) {
    fail(
      `expected ${describeValue(actual)} ${negated ? "not " : ""}to deeply equal ${describeValue(expected)}`
    );
  }
}

function assertSame(
  actual: unknown,
  expected: unknown,
  negated: boolean
): void {
  const ok = Object.is(actual, expected);
  if (!flip(negated, ok)) {
    fail(
      `expected ${describeValue(actual)} ${negated ? "not " : ""}to be ${describeValue(expected)}`
    );
  }
}

function assertTruthy(actual: unknown, negated: boolean): void {
  const ok = Boolean(actual);
  if (!flip(negated, ok)) {
    fail(
      `expected ${describeValue(actual)} ${negated ? "not " : ""}to be truthy`
    );
  }
}

function assertUndefined(actual: unknown, negated: boolean): void {
  const ok = actual === undefined;
  if (!flip(negated, ok)) {
    fail(
      `expected ${describeValue(actual)} ${negated ? "not " : ""}to be undefined`
    );
  }
}

function assertLength(actual: unknown, length: number, negated: boolean): void {
  const value = actual as { length?: unknown };
  if (typeof value?.length !== "number") {
    fail(`expected a value with .length, got ${describeValue(actual)}`);
  }
  const ok = value.length === length;
  if (!flip(negated, ok)) {
    fail(
      `expected length ${negated ? "not " : ""}to be ${length}, got ${value.length}`
    );
  }
}

export interface EvalMatchers<T> {
  /** Inverse of every matcher on this object. */
  readonly not: EvalMatchers<T>;

  /** Assert reference/scalar equality. */
  toBe(expected: T): void;

  /** Assert truthiness. */
  toBeTruthy(): void;

  /** Assert the value is `undefined`. */
  toBeUndefined(): void;

  /** Assert the output (or string) contains `substring`. */
  toContain(substring: string): void;

  /** Assert deep equality. */
  toEqual(expected: T): void;

  /**
   * Assert the run called every named tool. With `{ ordered: true }` the names
   * must appear as an in-order subsequence of the actual call sequence.
   *
   * Negated form asserts the run called NONE of the named tools — the
   * "avoid the dangerous tool" check.
   */
  toHaveCalledTools(
    names: readonly string[],
    options?: { readonly ordered?: boolean }
  ): void;

  /** Assert `.length` equals `length`. */
  toHaveLength(length: number): void;

  /** Assert the output (or string) matches `pattern`. */
  toMatch(pattern: RegExp): void;
}

export function expect<T>(actual: T): EvalMatchers<T> {
  const make = (negated: boolean): EvalMatchers<T> => ({
    get not() {
      return make(!negated);
    },
    toBe: (expected) => assertSame(actual, expected, negated),
    toBeTruthy: () => assertTruthy(actual, negated),
    toBeUndefined: () => assertUndefined(actual, negated),
    toContain: (substring) => assertContains(actual, substring, negated),
    toEqual: (expected) => assertEqual(actual, expected, negated),
    toHaveCalledTools: (names, options) =>
      assertCalledTools(actual, names, options, negated),
    toHaveLength: (length) => assertLength(actual, length, negated),
    toMatch: (pattern) => assertMatch(actual, pattern, negated),
  });
  return make(false);
}
