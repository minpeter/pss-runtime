// Programmatic eval runner. Importing the .eval.ts files registers them in the
// global registry; runEvals() then drives each one against a real agent thread.
//
// Equivalent CLI: `pss-eval --dir evals` (needs a TypeScript-capable Node or tsx).
import "../evals/safety.eval";
import "../evals/weather.eval";
import {
  formatJsonReport,
  formatTextReport,
  runEvals,
} from "@minpeter/pss-runtime/evals";

const asJson = process.argv.includes("--json");
const report = await runEvals();

process.stdout.write(
  `${asJson ? formatJsonReport(report) : formatTextReport(report)}\n`
);
process.exit(report.failed === 0 ? 0 : 1);
