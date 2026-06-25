import type {
  EvalCase,
  EvalCaseContext,
  EvalDefinition,
  EvalOptions,
} from "./types";

/**
 * Registers a case within an eval, mirroring vitest's `it`. Called from the
 * third argument to {@link defineEval}.
 */
export type EvalIt = (
  name: string,
  fn: (ctx: EvalCaseContext) => Promise<void> | void
) => void;

/**
 * The global registry. Eval files call {@link defineEval} at import time; the
 * CLI imports every `*.eval.ts` file, then the runner reads this registry.
 */
const registry: EvalDefinition[] = [];

/**
 * Define an eval suite. Each case runs against a freshly built thread from
 * `options.thread`, so conversation state never leaks between cases.
 *
 * @example
 * ```ts
 * defineEval("weather-safety", {
 *   thread: () => new Agent({ model, instructions, tools }).thread("eval"),
 * }, (it) => {
 *   it("calls get_weather", async ({ run }) => {
 *     const result = await run("서울 날씨 어때?");
 *     expect(result).toHaveCalledTools(["get_weather"]);
 *   });
 * });
 * ```
 */
export function defineEval(
  id: string,
  options: EvalOptions,
  register: (it: EvalIt) => void
): EvalDefinition {
  const cases: EvalCase[] = [];
  const it: EvalIt = (name, fn) => {
    cases.push({ fn, name });
  };
  register(it);

  const definition: EvalDefinition = {
    cases,
    id,
    tags: options.tags ? [...options.tags] : [],
    thread: options.thread,
  };
  registry.push(definition);
  return definition;
}

/** Read-only view of every registered eval. */
export function getEvals(): readonly EvalDefinition[] {
  return registry;
}

/** Clear the registry. Intended for tests that need isolation. */
export function clearEvals(): void {
  registry.length = 0;
}
