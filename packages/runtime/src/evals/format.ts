import type { CaseResult, EvalReport } from "./types-results";

function stateOf(result: CaseResult): string {
  if (result.passed) {
    return "PASS";
  }
  return result.scored ? "SCORED" : "FAIL";
}

function severityTag(record: {
  readonly severity: string;
  readonly threshold?: number;
}): string {
  if (record.severity === "soft") {
    return record.threshold === undefined
      ? "[soft]"
      : `[soft >=${record.threshold}]`;
  }
  return "[gate]";
}

function summarize(caseResult: CaseResult): string {
  const cache = cacheSummary(caseResult.cache);
  if (caseResult.assertions.length === 0) {
    return cache ?? "no assertions";
  }
  const gates = caseResult.assertions.filter((a) => a.severity === "gate");
  const gatePassed = gates.filter((a) => a.passed).length;
  return [`gates ${gatePassed}/${gates.length}`, cache]
    .filter((value) => value !== undefined)
    .join(", ");
}

function cacheSummary(cache: CaseResult["cache"]): string | undefined {
  if (cache.attemptedRequests === 0) {
    return;
  }
  if (cache.cacheHitRate === undefined) {
    return `cache hit n/a (${cache.trackedRequests}/${cache.attemptedRequests} requests tracked)`;
  }
  return `cache hit ${(cache.cacheHitRate * 100).toFixed(1)}% (${cache.trackedCacheReadTokens}/${cache.trackedInputTokens} tokens, ${cache.trackedRequests}/${cache.attemptedRequests} requests tracked)`;
}

function failureLine(record: {
  readonly label: string;
  readonly severity: string;
  readonly strictOnly: boolean;
  readonly threshold?: number;
  readonly score?: number;
  readonly failure?: string;
}): string {
  const detail = record.failure ? ` - ${record.failure}` : "";
  const score =
    record.score === undefined ? "" : ` score=${record.score.toFixed(2)}`;
  return `      FAIL  ${severityTag(record)} ${record.label}${score}${detail}`;
}

function passingSoftLine(record: {
  readonly label: string;
  readonly severity: string;
  readonly threshold?: number;
  readonly score?: number;
}): string | undefined {
  if (record.severity !== "soft" || record.score === undefined) {
    return;
  }
  return `      PASS  ${severityTag(record)} ${record.label} score=${record.score.toFixed(2)}`;
}

/** Render a report as human-readable text for the CLI and CI logs. */
export function formatTextReport(report: EvalReport): string {
  const strictTag = report.strict ? " (--strict)" : "";
  const lines: string[] = [];

  for (const result of report.results) {
    lines.push(
      `  ${stateOf(result)}  ${result.evalId} > ${result.name}  [${summarize(result)}]  ${result.durationMs}ms`
    );
    if (result.error) {
      lines.push(`      threw: ${result.error}`);
    }
    for (const record of result.assertions) {
      if (record.passed) {
        const soft = passingSoftLine(record);
        if (soft) {
          lines.push(soft);
        }
      } else {
        lines.push(failureLine(record));
      }
    }
  }

  const verdict = report.failed === 0 ? "PASSED" : "FAILED";
  const scored = report.results.filter((r) => r.scored && r.passed).length;
  const scoredNote = scored > 0 ? `, ${scored} scored` : "";
  const cache = cacheSummary(report.cache);
  const cacheNote = cache ? `, ${cache}` : "";
  lines.push("");
  lines.push(
    `Evals: ${report.passed} passed, ${report.failed} failed, ${report.total} total${scoredNote}${cacheNote} - ${verdict}${strictTag}`
  );
  return lines.join("\n");
}

/** Render a report as JSON for machine consumption (CI artifacts). */
export function formatJsonReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
