import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkflows } from "./report-hygiene.mjs";
import { SECURITY_RUNBOOK_PATH } from "./security-codeql.mjs";
import {
  gitleaksProblems,
  runbookGitleaksProblems,
} from "./security-gitleaks.mjs";
import {
  GITLEAKS_CONFIG_PATH,
  gitleaksConfigProblems,
} from "./security-gitleaks-config.mjs";

// gitleaks invariants (VAL-SEC-029..032): a workflow under .github/workflows
// parses and runs gitleaks in the declared full-history scope (checkout with
// fetch-depth: 0 plus `gitleaks git` against the committed config) on a
// bounded trigger set with read-only permissions; findings fail the run (no
// continue-on-error); the committed .gitleaks.toml extends the default rules
// with a line-scoped placeholder allowlist (no whole-file suppressions); the security-scan runbook documents the same scope, the
// triggers, the failure mode, triage, and the absent-local-binary behavior.

function gitleaksWorkflow({
  triggers = 'on:\n  push:\n    branches: [main]\n  pull_request:\n  schedule:\n    - cron: "17 4 * * 3"\n  workflow_dispatch:\n',
  topPermissions = "permissions:\n  contents: read\n\n",
  fetchDepth = "          fetch-depth: 0\n",
  scanRun = "./gitleaks git --config .gitleaks.toml --redact .",
  scanName = "Scan full git history (gitleaks git)",
  scanExtra = "",
  jobExtra = "",
} = {}) {
  return `name: gitleaks
${triggers}${topPermissions}jobs:
  scan:
    runs-on: ubuntu-latest
${jobExtra}    steps:
      - uses: actions/checkout@abc123 # v7
        with:
${fetchDepth}      - name: ${scanName}
        run: ${scanRun}
${scanExtra}`;
}

function problemsOf(...sources) {
  return gitleaksProblems(
    sources.map((source, index) => ({ path: `w${index}.yml`, source }))
  );
}

describe("gitleaks: explicit full-history scan scope (VAL-SEC-029)", () => {
  it("shipped workflows satisfy the gitleaks shape", () => {
    expect(gitleaksProblems(readWorkflows())).toEqual([]);
  });

  it("fails when no workflow runs gitleaks", () => {
    const problems = problemsOf("name: ci\non: push\njobs: {}\n");
    expect(problems.some((p) => p.includes("gitleaks"))).toBe(true);
  });

  it("parses as valid YAML and reports a parse error otherwise", () => {
    const problems = problemsOf("on: [unclosed\n");
    expect(problems.some((p) => p.includes("parse error"))).toBe(true);
  });

  it("fails when only another job has a full-history checkout", () => {
    const source = `${gitleaksWorkflow()}  other:\n    steps:\n      - uses: actions/checkout@abc123 # v7\n        with:\n          fetch-depth: 0\n`;
    const problems = problemsOf(
      source.replace(
        "      - uses: actions/checkout@abc123 # v7\n        with:\n",
        "      - uses: actions/checkout@abc123 # v7\n"
      )
    );
    expect(problems.some((p) => p.includes("fetch-depth: 0"))).toBe(true);
  });

  it("fails when the checkout is shallow (no fetch-depth: 0)", () => {
    const problems = problemsOf(gitleaksWorkflow({ fetchDepth: "" }));
    expect(problems.some((p) => p.includes("fetch-depth: 0"))).toBe(true);
  });

  it("fails when the scan step uses working-tree mode", () => {
    const problems = problemsOf(
      gitleaksWorkflow({ scanRun: "./gitleaks dir --config .gitleaks.toml ." })
    );
    expect(problems.some((p) => p.includes("working-tree"))).toBe(true);
  });

  it("fails when the scan step does not use the committed config", () => {
    const problems = problemsOf(
      gitleaksWorkflow({ scanRun: "./gitleaks git --redact ." })
    );
    expect(problems.some((p) => p.includes("--config"))).toBe(true);
  });

  it("fails when the scan step name does not declare the history scope", () => {
    const problems = problemsOf(gitleaksWorkflow({ scanName: "Scan secrets" }));
    expect(problems.some((p) => p.includes("history"))).toBe(true);
  });
});

describe("gitleaks: bounded triggers and read-only permissions (VAL-SEC-030)", () => {
  it("fails on a trigger outside the bounded set", () => {
    const problems = problemsOf(
      gitleaksWorkflow({ triggers: "on: [push, issues]\n" })
    );
    expect(problems.some((p) => p.includes('"issues"'))).toBe(true);
  });

  it("fails when the push trigger is not bounded to main", () => {
    const problems = problemsOf(
      gitleaksWorkflow({ triggers: "on:\n  push:\n  pull_request:\n" })
    );
    expect(problems.some((p) => p.includes("main"))).toBe(true);
  });

  it("fails without contents: read", () => {
    const problems = problemsOf(
      gitleaksWorkflow({ topPermissions: "permissions:\n  contents: none\n\n" })
    );
    expect(problems.some((p) => p.includes("contents: read"))).toBe(true);
  });

  it("fails when any write scope is granted", () => {
    const problems = problemsOf(
      gitleaksWorkflow({
        topPermissions: "permissions:\n  contents: read\n  actions: write\n\n",
      })
    );
    expect(problems.some((p) => p.includes('"actions: write"'))).toBe(true);
  });
});

describe("gitleaks: findings fail the workflow (VAL-SEC-032)", () => {
  it("fails when the scan step sets continue-on-error", () => {
    const problems = problemsOf(
      gitleaksWorkflow({ scanExtra: "        continue-on-error: true\n" })
    );
    expect(problems.some((p) => p.includes("continue-on-error"))).toBe(true);
  });

  it("fails when the scan job sets continue-on-error", () => {
    const problems = problemsOf(
      gitleaksWorkflow({ jobExtra: "    continue-on-error: true\n" })
    );
    expect(problems.some((p) => p.includes("continue-on-error"))).toBe(true);
  });
});

const VALID_CONFIG = `title = "fixture"

[extend]
useDefault = true

[allowlist]
regexes = [
  '''^[A-Z0-9_]+(API_KEY|TOKEN|SECRET)=\\.\\.\\.$''',
]
regexTarget = "line"
`;

describe("gitleaks: committed config allowlist (VAL-SEC-031)", () => {
  it("shipped .gitleaks.toml satisfies the allowlist shape", () => {
    expect(
      gitleaksConfigProblems(readFileSync(GITLEAKS_CONFIG_PATH, "utf8"))
    ).toEqual([]);
  });

  it("accepts a specific line-scoped placeholder allowlist", () => {
    expect(gitleaksConfigProblems(VALID_CONFIG)).toEqual([]);
  });

  it("fails on a whole-file example path exemption", () => {
    const mutated = VALID_CONFIG.replace(
      "[allowlist]",
      () => "[allowlist]\npaths = ['''^examples/\\.env\\.example$''']"
    );
    expect(
      gitleaksConfigProblems(mutated).some((p) => p.includes("whole files"))
    ).toBe(true);
  });

  it("fails when the config drops the default rule set", () => {
    const problems = gitleaksConfigProblems(
      VALID_CONFIG.replace("[extend]\nuseDefault = true\n", "")
    );
    expect(problems.some((p) => p.includes("useDefault"))).toBe(true);
  });

  it.each(["^.*$", String.raw`\.env\.example`, String.raw`^\.env\.example$`])(
    "fails on a whole-file path suppression %s",
    (path) => {
      const problems = gitleaksConfigProblems(
        VALID_CONFIG.replace(
          "[allowlist]",
          () => `[allowlist]\npaths = ['''${path}''']`
        )
      );
      expect(problems.length).toBeGreaterThan(0);
    }
  );

  it("fails on a catch-all regex suppression", () => {
    const problems = gitleaksConfigProblems(
      VALID_CONFIG.replace(
        "'''^[A-Z0-9_]+(API_KEY|TOKEN|SECRET)=\\.\\.\\.$'''",
        "'''.*'''"
      )
    );
    expect(problems.some((p) => p.includes("catch-all"))).toBe(true);
  });

  it("fails when the allowlist is empty", () => {
    const problems = gitleaksConfigProblems(
      VALID_CONFIG.replace(
        "'''^[A-Z0-9_]+(API_KEY|TOKEN|SECRET)=\\.\\.\\.$''',",
        ""
      )
    );
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("gitleaks: runbook documents scope, triggers, triage (VAL-SEC-029/032)", () => {
  it("shipped security-scan runbook documents the gitleaks contract", () => {
    expect(
      runbookGitleaksProblems(readFileSync(SECURITY_RUNBOOK_PATH, "utf8"))
    ).toEqual([]);
  });

  it("fails when the runbook drops the gitleaks section", () => {
    const problems = runbookGitleaksProblems(
      "# Security-scan failure triage\n\nTriage scan findings locally.\n"
    );
    expect(problems.some((p) => p.includes("gitleaks"))).toBe(true);
    expect(problems.some((p) => p.includes("full-history"))).toBe(true);
    expect(problems.some((p) => p.includes("rotating"))).toBe(true);
    expect(problems.some((p) => p.includes(".gitleaks.toml"))).toBe(true);
  });
});
