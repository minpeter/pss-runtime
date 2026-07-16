import type { EvalCase, EvalDefinition, EvalOptions, EvalScope } from "./types";

/** Registers a case within an eval, mirroring vitest's `it`. */
export type EvalIt = (
  name: string,
  fn: (t: EvalScope) => Promise<void> | void
) => void;

/** The global registry. Eval files call {@link defineEval} at import time. */
const registry: EvalDefinition[] = [];

/**
 * Define an eval suite. Each case runs against a freshly built thread from
 * `options.thread`, so conversation state never leaks between cases.
 *
 * @example
 * ```ts
 * defineEval("weather", {
 *   thread: async () =>
 *     (await createAgent({ model, instructions, tools })).thread("eval"),
 * }, (it) => {
 *   it("calls get_weather", async (t) => {
 *     await t.run("서울 날씨 어때?");
 *     t.calledTool("get_weather");
 *     t.notCalledTool("send_email");
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
    judge: options.judge,
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
