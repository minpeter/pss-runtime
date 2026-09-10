import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkflows } from "./report-hygiene.mjs";
import {
  CI_WORKFLOW_PATH,
  ciZapProblems,
  ZAP_WORKFLOW_PATH,
  zapProblems,
} from "./security-zap.mjs";

// OWASP ZAP baseline workflow invariants (VAL-SEC-034..037): a distinct
// workflow under .github/workflows parses, runs the SHA-pinned zaproxy
// baseline action only on manual workflow_dispatch with a required
// target-url input whose default is EMPTY (never loopback, never any host);
// an empty input skips the scan with a visible message; a supplied target
// runs under a bounded timeout-minutes with the spider/scan scope
// constrained to the declared target; the job holds contents: read and no
// write scope; ci.yml never references ZAP. All checks are static over
// committed files and pure fixtures.

const EXPR_OPEN = "${{";
const EXPR_CLOSE = "}}";
const expr = (body) => `${EXPR_OPEN} ${body} ${EXPR_CLOSE}`;

function zapWorkflow({
  triggers = 'on:\n  workflow_dispatch:\n    inputs:\n      target-url:\n        required: true\n        type: string\n        default: ""\n',
  topPermissions = "permissions:\n  contents: read\n\n",
  jobTimeout = "    timeout-minutes: 20\n",
  jobPermissions = "    permissions:\n      contents: read\n",
  includeSkip = true,
  skipRun = 'echo "ZAP baseline scan skipped - no target-url input provided"',
  scanGuard = expr("inputs.target-url != ''"),
  zapUses = "zaproxy/action-baseline@de8ad967d3548d44ef623df22cf95c3b0baf8b25 # v0.15.0",
  target = expr("inputs.target-url"),
  cmdOptions = '"-m 5"',
} = {}) {
  const skipStep = includeSkip
    ? `      - name: Skip scan (no target declared)\n        if: ${expr("inputs.target-url == ''")}\n        run: ${skipRun}\n`
    : "";
  const scanIf = scanGuard === null ? "" : `        if: ${scanGuard}\n`;
  return `name: zap
${triggers}${topPermissions}jobs:
  baseline:
    runs-on: ubuntu-latest
${jobTimeout}${jobPermissions}    steps:
${skipStep}      - name: ZAP baseline scan
${scanIf}        uses: ${zapUses}
        with:
          target: "${target}"
          cmd_options: ${cmdOptions}
`;
}

function problemsOf(...sources) {
  return zapProblems(
    sources.map((source, index) => ({ path: `zap${index}.yml`, source }))
  );
}

const PUSH_TRIGGER =
  'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n    inputs:\n      target-url:\n        required: true\n        default: ""\n';

describe("zap: manual-dispatch-only trigger, required target-url (VAL-SEC-034)", () => {
  it("shipped workflows satisfy the ZAP shape", () => {
    expect(zapProblems(readWorkflows())).toEqual([]);
  });

  it("fails when no workflow runs the ZAP baseline scan", () => {
    const problems = zapProblems([
      { path: "ci.yml", source: "name: ci\non: push\njobs: {}\n" },
    ]);
    expect(problems.some((p) => p.includes("ZAP baseline"))).toBe(true);
  });

  it("parses as valid YAML and reports a parse error otherwise", () => {
    const problems = problemsOf("on: [unclosed\n");
    expect(problems.some((p) => p.includes("parse error"))).toBe(true);
  });

  it("fails when a push trigger is added", () => {
    const problems = problemsOf(zapWorkflow({ triggers: PUSH_TRIGGER }));
    expect(problems.some((p) => p.includes("workflow_dispatch only"))).toBe(
      true
    );
  });

  it("fails on a schedule trigger", () => {
    const problems = problemsOf(
      zapWorkflow({
        triggers:
          'on:\n  schedule:\n    - cron: "0 0 * * 0"\n  workflow_dispatch:\n    inputs:\n      target-url:\n        required: true\n        default: ""\n',
      })
    );
    expect(problems.some((p) => p.includes("schedule"))).toBe(true);
  });

  it("fails when the target-url input is missing", () => {
    const problems = problemsOf(
      zapWorkflow({ triggers: "on:\n  workflow_dispatch:\n" })
    );
    expect(problems.some((p) => p.includes("target-url"))).toBe(true);
  });

  it("fails when the target-url input is not required", () => {
    const problems = problemsOf(
      zapWorkflow({
        triggers:
          'on:\n  workflow_dispatch:\n    inputs:\n      target-url:\n        required: false\n        default: ""\n',
      })
    );
    expect(problems.some((p) => p.includes("required: true"))).toBe(true);
  });
});

describe("zap: empty default, never loopback, visible skip (VAL-SEC-035)", () => {
  it("fails when the default target is a hardcoded host", () => {
    const problems = problemsOf(
      zapWorkflow({
        triggers:
          'on:\n  workflow_dispatch:\n    inputs:\n      target-url:\n        required: true\n        default: "https://staging.example.com"\n',
      })
    );
    expect(problems.some((p) => p.includes("EMPTY"))).toBe(true);
  });

  it("fails when the default target is a loopback address", () => {
    const problems = problemsOf(
      zapWorkflow({
        triggers:
          'on:\n  workflow_dispatch:\n    inputs:\n      target-url:\n        required: true\n        default: "http://127.0.0.1:3000"\n',
      })
    );
    expect(problems.some((p) => p.includes("EMPTY"))).toBe(true);
  });

  it("fails when no skip step guards the empty input", () => {
    const problems = problemsOf(zapWorkflow({ includeSkip: false }));
    expect(problems.some((p) => p.includes("skip step"))).toBe(true);
  });

  it("fails when the skip step logs no explicit skip message", () => {
    const problems = problemsOf(
      zapWorkflow({ skipRun: 'echo "nothing to do"' })
    );
    expect(problems.some((p) => p.includes("skip message"))).toBe(true);
  });

  it("fails when the scan step is not guarded by a non-empty input", () => {
    const problems = problemsOf(zapWorkflow({ scanGuard: null }));
    expect(problems.some((p) => p.includes("non-empty target-url"))).toBe(true);
  });

  it("fails when the scan target is a hardcoded host", () => {
    const problems = problemsOf(
      zapWorkflow({ target: "https://app.example.com" })
    );
    expect(problems.some((p) => p.includes("hardcoded"))).toBe(true);
  });

  it("fails when cmd_options declares a host outside the declared target", () => {
    const problems = problemsOf(
      zapWorkflow({ cmdOptions: '"-m 5 https://other.example.com"' })
    );
    expect(problems.some((p) => p.includes("cmd_options"))).toBe(true);
  });

  it("fails when a step references a loopback address", () => {
    const problems = problemsOf(
      zapWorkflow({ skipRun: 'echo "skipped; never localhost by default"' })
    );
    expect(problems.some((p) => p.includes("loopback"))).toBe(true);
  });
});

describe("zap: bounded timeout and read-only permissions (VAL-SEC-035/037)", () => {
  it("fails without a timeout-minutes bound", () => {
    const problems = problemsOf(zapWorkflow({ jobTimeout: "" }));
    expect(problems.some((p) => p.includes("timeout-minutes"))).toBe(true);
  });

  it("fails when the timeout is not bounded", () => {
    const problems = problemsOf(
      zapWorkflow({ jobTimeout: "    timeout-minutes: 120\n" })
    );
    expect(problems.some((p) => p.includes("timeout-minutes"))).toBe(true);
  });

  it("fails without contents: read", () => {
    const problems = problemsOf(
      zapWorkflow({
        jobPermissions: "    permissions:\n      contents: write\n",
      })
    );
    expect(problems.some((p) => p.includes("contents: read"))).toBe(true);
  });

  it("fails when any write scope is granted", () => {
    const problems = problemsOf(
      zapWorkflow({
        topPermissions: "permissions:\n  contents: read\n  issues: write\n\n",
      })
    );
    expect(problems.some((p) => p.includes('"issues: write"'))).toBe(true);
  });

  it("fails when the action is tag-pinned instead of SHA-pinned", () => {
    const problems = problemsOf(
      zapWorkflow({ zapUses: "zaproxy/action-baseline@v0.15.0" })
    );
    expect(problems.some((p) => p.includes("pinned"))).toBe(true);
  });
});

describe("zap: ci.yml never references ZAP (VAL-SEC-036)", () => {
  it("the ZAP workflow is a distinct file from ci.yml", () => {
    expect(ZAP_WORKFLOW_PATH).not.toEqual(CI_WORKFLOW_PATH);
  });

  it("shipped ci.yml contains no zap step or reference", () => {
    expect(ciZapProblems(readFileSync(CI_WORKFLOW_PATH, "utf8"))).toEqual([]);
  });

  it("fails when ci.yml contains a zap step", () => {
    const problems = ciZapProblems(
      "name: CI\non: push\njobs:\n  checks:\n    steps:\n      - run: zap-baseline.py\n"
    );
    expect(problems.some((p) => p.includes("never invoke"))).toBe(true);
  });
});
