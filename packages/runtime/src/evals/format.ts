import type { EvalReport } from "./types";

/** Render a report as human-readable text for the CLI and CI logs. */
export function formatTextReport(report: EvalReport): string {
  const lines: string[] = [];
  let maxLabel = 0;
  for (const result of report.results) {
    maxLabel = Math.max(maxLabel, `${result.evalId} > ${result.name}`.length);
  }

  for (const result of report.results) {
    const label = `${result.evalId} > ${result.name}`;
    const status = result.passed ? "PASS" : "FAIL";
    lines.push(
      `  ${status}  ${label.padEnd(maxLabel)}  ${result.durationMs}ms`
    );
    if (!result.passed && result.error) {
      const indented = result.error.replace(/\n/g, "\n      ");
      lines.push(`      ${indented}`);
    }
  }

  const verdict = report.failed === 0 ? "PASSED" : "FAILED";
  lines.push("");
  lines.push(
    `Evals: ${report.passed} passed, ${report.failed} failed, ${report.total} total — ${verdict}`
  );
  return lines.join("\n");
}

/** Render a report as JSON for machine consumption (CI artifacts). */
export function formatJsonReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
