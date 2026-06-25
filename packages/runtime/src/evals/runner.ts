import { getEvals } from "./registry";
import { EvalScopeImpl } from "./scope";
import type {
  AssertionRecord,
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

function verdict(
  records: readonly AssertionRecord[],
  strict: boolean
): {
  passed: boolean;
  scored: boolean;
} {
  let gateFailed = false;
  let softMiss = false;
  for (const record of records) {
    if (record.severity === "gate") {
      if (!record.passed) {
        gateFailed = true;
      }
    } else if (!record.passed) {
      softMiss = true;
    }
  }
  const passed = !(gateFailed || (strict && softMiss));
  return { passed, scored: softMiss };
}

/**
 * Run every registered eval (optionally filtered) and return a report. Each
 * case gets a fresh recording scope and thread; assertion failures are recorded
 * (not thrown), so a run reports every failing assertion (eve-style
 * multi-verdict). Soft assertions are tracked data, fatal only under `strict`.
 */
export async function runEvals(
  options: RunEvalsOptions = {}
): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const strict = options.strict ?? false;
  const results: CaseResult[] = [];

  for (const def of selectEvals(options)) {
    for (const caseEntry of def.cases) {
      const started = Date.now();
      const scope = new EvalScopeImpl(def.thread());
      let error: string | undefined;
      try {
        await caseEntry.fn(scope);
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      const records = scope.records;
      const { passed, scored } =
        error === undefined
          ? verdict(records, strict)
          : { passed: false, scored: false };
      results.push({
        assertions: records,
        durationMs: Date.now() - started,
        error,
        evalId: def.id,
        name: caseEntry.name,
        passed,
        scored,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    failed: results.length - passed,
    passed,
    results,
    startedAt,
    strict,
    total: results.length,
  };
}
