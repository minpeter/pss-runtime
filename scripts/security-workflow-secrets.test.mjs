import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkflows } from "./report-hygiene.mjs";
import {
  runbookSecretPolicyProblems,
  SECURITY_RUNBOOK_PATH,
  securityWorkflowPaths,
  securityWorkflowSecretsProblems,
} from "./security-workflow-secrets.mjs";

// Security-workflow secret invariants (VAL-SEC-033): no security workflow
// (CodeQL, gitleaks, ZAP) references an authored repository/environment
// secret (`secrets.*`), sets a provider/Telegram credential env var
// (AI_API_KEY, WORKER_AGENT_TUI_*, Telegram tokens), or interpolates secret
// values into run/echo steps. The auto-injected github.token is permitted
// only as an env value consumed by a tool and is never printed or logged.
// All checks are static over committed files and pure fixtures.

function securityWorkflow({ topEnv = "", jobEnv = "", extraSteps = "" } = {}) {
  return `name: gitleaks
on:
  push:
    branches: [main]
permissions:
  contents: read
${topEnv}jobs:
  scan:
    runs-on: ubuntu-latest
${jobEnv}    steps:
      - uses: actions/checkout@abc123 # v7
      - run: ./gitleaks git --config .gitleaks.toml --redact .
${extraSteps}`;
}

function nonSecurityWorkflow() {
  return `name: Release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc123 # v7
      - run: pnpm build
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}

// Build a GitHub Actions expression without a literal `${` sequence in a
// plain string, which biome's noTemplateCurlyInString rule forbids.
const ghExpr = (inner) => ["$", "{{ ", inner, " }}"].join("");

function problemsOf(...sources) {
  return securityWorkflowSecretsProblems(
    sources.map((source, index) => ({ path: `w${index}.yml`, source }))
  );
}

describe("security-workflow secrets: shipped tree (VAL-SEC-033)", () => {
  it("shipped security workflows reference no authored secrets", () => {
    expect(securityWorkflowSecretsProblems(readWorkflows())).toEqual([]);
  });

  it("classifies codeql.yml and gitleaks.yml as security workflows", () => {
    const paths = securityWorkflowPaths(readWorkflows());
    expect(paths).toContain(".github/workflows/codeql.yml");
    expect(paths).toContain(".github/workflows/gitleaks.yml");
  });

  it("does not classify release or extended-verification workflows", () => {
    const paths = securityWorkflowPaths(readWorkflows());
    expect(paths).not.toContain(".github/workflows/release.yml");
    expect(paths).not.toContain(".github/workflows/extended-verification.yml");
  });
});

describe("security-workflow secrets: no authored secrets (VAL-SEC-033)", () => {
  it("fails when no security workflow exists at all", () => {
    const problems = problemsOf("name: ci\non: push\njobs: {}\n");
    expect(problems.some((p) => p.includes("no security workflow"))).toBe(true);
  });

  it("fails on a secrets.* reference in an env value", () => {
    const problems = problemsOf(
      securityWorkflow({
        extraSteps: `      - run: ./gitleaks version\n        env:\n          SCAN_TOKEN: ${ghExpr("secrets.SCAN_TOKEN")}\n`,
      })
    );
    expect(problems.some((p) => p.includes("secrets.*"))).toBe(true);
  });

  it("fails on secrets.* interpolation inside a run step", () => {
    const problems = problemsOf(
      securityWorkflow({
        extraSteps: `      - run: echo "token=${ghExpr("secrets.SCAN_TOKEN")}"\n`,
      })
    );
    expect(
      problems.some((p) => p.includes("secrets.*") && p.includes(".run"))
    ).toBe(true);
  });

  it("fails on case-variant Secrets.*/GITHUB.TOKEN references", () => {
    const problems = problemsOf(
      securityWorkflow({
        extraSteps: `      - run: echo "token=${ghExpr("Secrets.SCAN_TOKEN")} ${ghExpr("github.Token")}"\n`,
      })
    );
    expect(problems.some((p) => p.includes("secrets.*"))).toBe(true);
    expect(problems.some((p) => p.includes("github.token"))).toBe(true);
  });

  it("ignores secrets in non-security workflows", () => {
    const problems = problemsOf(nonSecurityWorkflow(), securityWorkflow());
    expect(problems).toEqual([]);
  });

  it("reports a parse error for invalid YAML", () => {
    const problems = problemsOf("on: [unclosed\n");
    expect(problems.some((p) => p.includes("parse error"))).toBe(true);
  });
});

describe("security-workflow secrets: credential env vars (VAL-SEC-033)", () => {
  it("fails when a step sets AI_API_KEY", () => {
    const problems = problemsOf(
      securityWorkflow({
        extraSteps:
          "      - run: ./gitleaks version\n        env:\n          AI_API_KEY: placeholder\n",
      })
    );
    expect(problems.some((p) => p.includes("AI_API_KEY"))).toBe(true);
  });

  it("fails when a job sets a WORKER_AGENT_TUI_* var", () => {
    const problems = problemsOf(
      securityWorkflow({
        jobEnv: "    env:\n      WORKER_AGENT_TUI_ENDPOINT: placeholder\n",
      })
    );
    expect(problems.some((p) => p.includes("WORKER_AGENT_TUI_"))).toBe(true);
  });

  it("fails when the workflow sets a Telegram credential", () => {
    const problems = problemsOf(
      securityWorkflow({
        topEnv: "env:\n  TELEGRAM_BOT_TOKEN: placeholder\n",
      })
    );
    expect(problems.some((p) => p.includes("TELEGRAM_BOT_TOKEN"))).toBe(true);
  });
});

describe("security-workflow secrets: github.token policy (VAL-SEC-033)", () => {
  it("permits github.token as an env value consumed by a tool", () => {
    const problems = problemsOf(
      securityWorkflow({
        extraSteps: `      - run: ./gitleaks version\n        env:\n          GH_TOKEN: ${ghExpr("github.token")}\n`,
      })
    );
    expect(problems).toEqual([]);
  });

  it("fails when a run step prints github.token", () => {
    const problems = problemsOf(
      securityWorkflow({
        extraSteps: `      - run: echo "${ghExpr("github.token")}"\n`,
      })
    );
    expect(
      problems.some(
        (p) => p.includes("github.token") && p.includes("never printed")
      )
    ).toBe(true);
  });

  it("fails when github.token is passed outside an env value", () => {
    const problems = problemsOf(
      securityWorkflow({
        extraSteps: `      - uses: actions/checkout@abc123 # v7\n        with:\n          token: ${ghExpr("github.token")}\n`,
      })
    );
    expect(problems.some((p) => p.includes("github.token"))).toBe(true);
  });
});

describe("security-workflow secrets: runbook documents the policy (VAL-SEC-033)", () => {
  it("shipped security-scan runbook documents the secret policy", () => {
    expect(
      runbookSecretPolicyProblems(readFileSync(SECURITY_RUNBOOK_PATH, "utf8"))
    ).toEqual([]);
  });

  it("fails when the runbook drops the secret-policy section", () => {
    const problems = runbookSecretPolicyProblems(
      "# Security-scan failure triage\n\nTriage scan findings locally.\n"
    );
    expect(problems.some((p) => p.includes("secrets.*"))).toBe(true);
    expect(problems.some((p) => p.includes("github.token"))).toBe(true);
    expect(problems.some((p) => p.includes("never printed"))).toBe(true);
  });
});
