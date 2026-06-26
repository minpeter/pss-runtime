import {
  formatJsonReport,
  formatTextReport,
  runEvals,
} from "@minpeter/pss-runtime/evals";

import "./worker-behavior.eval";

await import("./conversation-continuity.eval");
await import("./delivery-cases.eval");
await import("./session-list-cases.eval");
await import("./session-privacy-cases.eval");
await import("./session-recall-cases.eval");

if (process.env.PSS_WORKER_AGENT_EVAL_REMOTE === "1") {
  await import("./remote-tui.eval");
}

const asJson = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const report = await runEvals({ strict });

process.stdout.write(
  `${asJson ? formatJsonReport(report) : formatTextReport(report)}\n`
);
process.exitCode = report.failed === 0 ? 0 : 1;
