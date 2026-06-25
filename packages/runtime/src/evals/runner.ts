import { runAgent } from "./harness";
import { getEvals } from "./registry";
import type {
  CaseResult,
  EvalDefinition,
  EvalReport,
  RunEvalsOptions,
} from "./types";

function matchesId(id: string, filter: string | RegExp | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  return typeof filter === "string" ? id.includes(filter) : filter.test(id);
}

function matchesTags(
  evalTags: readonly string[],
  want: readonly string[] | undefined
): boolean {
  if (!want || want.length === 0) {
    return true;
  }
  return want.every((tag) => evalTags.includes(tag));
}

function selectEvals(options: RunEvalsOptions): readonly EvalDefinition[] {
  return getEvals().filter(
    (def) =>
      matchesId(def.id, options.filter) && matchesTags(def.tags, options.tags)
  );
}

/**
 * Run every registered eval (optionally filtered) and return a report. Each
 * case gets a fresh thread from its eval's factory, so cases never share
 * conversation state. Assertion failures are caught and recorded as a failed
 * case rather than aborting the whole run.
 */
export async function runEvals(
  options: RunEvalsOptions = {}
): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];

  for (const def of selectEvals(options)) {
    for (const caseEntry of def.cases) {
      const started = Date.now();
      let passed = true;
      let error: string | undefined;
      try {
        const thread = def.thread();
        await caseEntry.fn({
          run: (input) => runAgent(thread, input),
        });
      } catch (e) {
        passed = false;
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      results.push({
        durationMs: Date.now() - started,
        error,
        evalId: def.id,
        name: caseEntry.name,
        passed,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    failed: results.length - passed,
    passed,
    results,
    startedAt,
    total: results.length,
  };
}
