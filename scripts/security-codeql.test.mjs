import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkflows } from "./report-hygiene.mjs";
import {
  codeqlProblems,
  runbookCodeqlProblems,
  SECURITY_RUNBOOK_PATH,
} from "./security-codeql.mjs";

// CodeQL workflow invariants (VAL-SEC-027/028): a workflow under
// .github/workflows parses and runs codeql-action init/analyze for the
// JavaScript/TypeScript language on a bounded trigger set, holds only
// contents: read plus security-events: write, and fails visibly (never
// silently) when the SARIF upload fails; the security-scan runbook documents
// that failure mode and its recovery. All checks are static over committed
// files and pure fixtures.

function codeqlWorkflow({
  triggers = 'on:\n  push:\n    branches: [main]\n  pull_request:\n  schedule:\n    - cron: "41 3 * * 2"\n  workflow_dispatch:\n',
  topPermissions = "permissions:\n  contents: read\n\n",
  jobPermissions = "    permissions:\n      contents: read\n      security-events: write\n",
  languages = "javascript-typescript",
  analyzeUses = "github/codeql-action/analyze@abc123 # v3",
  analyzeStepExtra = "",
  jobExtra = "",
} = {}) {
  return `name: CodeQL
${triggers}${topPermissions}jobs:
  analyze:
    runs-on: ubuntu-latest
${jobPermissions}${jobExtra}    steps:
      - uses: actions/checkout@abc123 # v7
      - uses: github/codeql-action/init@abc123 # v3
        with:
          languages: ${languages}
${analyzeStepExtra}      - uses: ${analyzeUses}
`;
}

function problemsOf(...sources) {
  return codeqlProblems(
    sources.map((source, index) => ({ path: `w${index}.yml`, source }))
  );
}

describe("codeql: workflow shape (VAL-SEC-027)", () => {
  it("shipped workflows satisfy the CodeQL shape", () => {
    expect(codeqlProblems(readWorkflows())).toEqual([]);
  });

  it("fails when no workflow runs codeql-action", () => {
    const problems = problemsOf("name: ci\non: push\njobs: {}\n");
    expect(problems.some((p) => p.includes("codeql-action"))).toBe(true);
  });

  it("fails when init and analyze are in different jobs", () => {
    const source =
      codeqlWorkflow()
        .replace(
          "      - uses: actions/checkout@abc123 # v7\n",
          "      - uses: github/codeql-action/analyze@abc123 # v3\n"
        )
        .replace("      - uses: github/codeql-action/init@abc123 # v3\n", "") +
      "  init:\n    steps:\n      - uses: github/codeql-action/init@abc123 # v3\n        with:\n          languages: javascript-typescript\n";
    const problems = problemsOf(source);
    expect(
      problems.some((p) => p.includes("both CodeQL init and analyze"))
    ).toBe(true);
  });

  it("fails when the analyze step is missing", () => {
    const problems = problemsOf(
      codeqlWorkflow({ analyzeUses: "" }).replace("      - uses: \n", "")
    );
    expect(problems.some((p) => p.includes("analyze"))).toBe(true);
  });

  it("fails when the init step declares no JavaScript/TypeScript language", () => {
    const problems = problemsOf(codeqlWorkflow({ languages: "python" }));
    expect(problems.some((p) => p.includes("JavaScript/TypeScript"))).toBe(
      true
    );
  });

  it("parses as valid YAML and reports a parse error otherwise", () => {
    const problems = problemsOf("on: [unclosed\n");
    expect(problems.some((p) => p.includes("parse error"))).toBe(true);
  });
});

describe("codeql: bounded triggers and minimal permissions (VAL-SEC-028)", () => {
  it("fails on a trigger outside the bounded set", () => {
    const problems = problemsOf(
      codeqlWorkflow({ triggers: "on: [push, issues]\n" })
    );
    expect(problems.some((p) => p.includes('"issues"'))).toBe(true);
  });

  it("fails when the push trigger is not bounded to main", () => {
    const problems = problemsOf(
      codeqlWorkflow({ triggers: "on:\n  push:\n  pull_request:\n" })
    );
    expect(problems.some((p) => p.includes("main"))).toBe(true);
  });

  it("fails without contents: read", () => {
    const problems = problemsOf(
      codeqlWorkflow({
        jobPermissions:
          "    permissions:\n      contents: write\n      security-events: write\n",
      })
    );
    expect(problems.some((p) => p.includes("contents: read"))).toBe(true);
  });

  it("fails without security-events: write on the analyze job", () => {
    const problems = problemsOf(
      codeqlWorkflow({
        jobPermissions: "    permissions:\n      contents: read\n",
      })
    );
    expect(problems.some((p) => p.includes("security-events"))).toBe(true);
  });

  it("fails when an extra write scope is granted", () => {
    const problems = problemsOf(
      codeqlWorkflow({
        topPermissions: "permissions:\n  contents: read\n  actions: write\n\n",
      })
    );
    expect(problems.some((p) => p.includes('"actions: write"'))).toBe(true);
  });
});

describe("codeql: upload failure stays visible (VAL-SEC-028)", () => {
  it("fails when the analyze step sets continue-on-error", () => {
    const problems = problemsOf(
      codeqlWorkflow({
        analyzeStepExtra: "",
        jobExtra: "",
      }).replace(
        "      - uses: github/codeql-action/analyze@abc123 # v3\n",
        "      - uses: github/codeql-action/analyze@abc123 # v3\n        continue-on-error: true\n"
      )
    );
    expect(problems.some((p) => p.includes("continue-on-error"))).toBe(true);
  });

  it("fails when the analyze job sets continue-on-error", () => {
    const problems = problemsOf(
      codeqlWorkflow({ jobExtra: "    continue-on-error: true\n" })
    );
    expect(problems.some((p) => p.includes("continue-on-error"))).toBe(true);
  });

  it("fails when the analyze step disables the upload", () => {
    const problems = problemsOf(
      codeqlWorkflow().replace(
        "      - uses: github/codeql-action/analyze@abc123 # v3\n",
        "      - uses: github/codeql-action/analyze@abc123 # v3\n        with:\n          upload: never\n"
      )
    );
    expect(problems.some((p) => p.includes("upload: never"))).toBe(true);
  });
});

describe("codeql: runbook documents the upload-failure mode (VAL-SEC-028)", () => {
  it("shipped security-scan runbook documents failure mode and recovery", () => {
    expect(
      runbookCodeqlProblems(readFileSync(SECURITY_RUNBOOK_PATH, "utf8"))
    ).toEqual([]);
  });

  it("fails when the runbook drops the CodeQL upload-failure section", () => {
    const problems = runbookCodeqlProblems(
      "# Security-scan failure triage\n\nTriage scan findings locally.\n"
    );
    expect(problems.some((p) => p.includes("CodeQL"))).toBe(true);
    expect(problems.some((p) => p.includes("upload-failure"))).toBe(true);
    expect(problems.some((p) => p.includes("recovery"))).toBe(true);
  });
});
