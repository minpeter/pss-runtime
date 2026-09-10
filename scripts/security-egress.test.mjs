import { describe, expect, it } from "vitest";
import { readWorkflows } from "./report-hygiene.mjs";
import {
  externalEgressProblems,
  GATED_WORKFLOW_PATH,
} from "./security-egress.mjs";

// No-external-egress workflow invariants (VAL-SEC-040): no ci.yml or
// analysis/security workflow step sets provider/Telegram credentials or
// invokes a real http(s) target; external calls exist only in
// extended-verification.yml behind the secret-gate jobs, which are never
// part of local exit-0 claims. Static over committed files and fixtures.

// Built at runtime so the shipped-tree non-loopback-address ban never
// self-flags the fixtures in this file.
const NON_LOOPBACK_IP = ["0", "0", "0", "0"].join(".");
const GATED_WORKFLOW_NAME = /extended-verification/;

// Build a GitHub Actions expression without a literal `${` sequence in a
// plain string, which biome's noTemplateCurlyInString rule forbids.
const ghExpr = (inner) => ["$", "{{ ", inner, " }}"].join("");

function ciLikeWorkflow(extra = "") {
  return `name: CI
on: [push, pull_request]
permissions:
  contents: read
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc123 # v7
      - run: pnpm test
        env:
          PSS_TASK_VALIDATOR_NETWORK_ISOLATED: "1"
${extra}`;
}

function gatedWorkflow({ liveIf = "", liveNeeds = "secret-gate" } = {}) {
  const liveCondition =
    liveIf || ghExpr("needs.secret-gate.outputs.provider == 'true'");
  return `name: Extended verification
on: workflow_dispatch
permissions:
  contents: read
jobs:
  secret-gate:
    runs-on: ubuntu-latest
    outputs:
      provider: \${{ steps.detect.outputs.provider }}
      remote_edge: \${{ steps.detect.outputs.remote_edge }}
    steps:
      - id: detect
        env:
          AI_API_KEY: ${ghExpr("secrets.AI_API_KEY")}
        run: echo "provider=true" >> "$GITHUB_OUTPUT"
  live-provider:
    needs: ${liveNeeds}
    if: ${liveCondition}
    runs-on: ubuntu-latest
    steps:
      - run: pnpm eval:provider
        env:
          AI_API_KEY: ${ghExpr("secrets.AI_API_KEY")}
          AI_BASE_URL: ${ghExpr("secrets.AI_BASE_URL || 'https://provider.invalid/v1'")}
  remote-edge:
    needs: secret-gate
    if: \${{ needs.secret-gate.outputs.remote_edge == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - run: pnpm eval:edge-remote
        env:
          WORKER_AGENT_TUI_ENDPOINT: ${ghExpr("secrets.WORKER_AGENT_TUI_ENDPOINT")}
          WORKER_AGENT_TUI_TOKEN: ${ghExpr("secrets.WORKER_AGENT_TUI_TOKEN")}
`;
}

function problemsOf(entries) {
  return externalEgressProblems(
    entries.map(([path, source]) => ({ path, source }))
  );
}

describe("no external egress: shipped tree (VAL-SEC-040)", () => {
  it("no workflow step sets credentials or calls a real external target", () => {
    expect(externalEgressProblems(readWorkflows())).toEqual([]);
  });

  it("treats only extended-verification.yml as the secret-gated workflow", () => {
    const paths = readWorkflows().map(({ path }) => path);
    expect(paths).toContain(GATED_WORKFLOW_PATH);
    for (const path of paths) {
      if (path !== GATED_WORKFLOW_PATH) {
        expect(path).not.toMatch(GATED_WORKFLOW_NAME);
      }
    }
  });
});

describe("no external egress: workflow rules (VAL-SEC-040)", () => {
  it("fails when a non-gated workflow runs a credential-gated eval", () => {
    const problems = problemsOf([
      [".github/workflows/ci.yml", ciLikeWorkflow()],
      [
        ".github/workflows/other.yml",
        ciLikeWorkflow("      - run: pnpm eval:provider\n"),
      ],
    ]);
    expect(problems.some((p) => p.includes("eval:provider"))).toBe(true);
  });

  it("fails on a credential env var in a non-gated workflow", () => {
    const problems = problemsOf([
      [
        ".github/workflows/ci.yml",
        ciLikeWorkflow(
          `      - run: pnpm test\n        env:\n          AI_API_KEY: ${ghExpr("secrets.AI_API_KEY")}\n`
        ),
      ],
    ]);
    expect(problems.some((p) => p.includes("AI_API_KEY"))).toBe(true);
    expect(problems.some((p) => p.includes("secrets.AI_API_KEY"))).toBe(true);
  });

  it("fails on a Telegram API call in a security workflow", () => {
    const problems = problemsOf([
      [
        ".github/workflows/zap.yml",
        ciLikeWorkflow(
          "      - run: curl https://api.telegram.org/bot123/getMe\n"
        ),
      ],
    ]);
    expect(problems.some((p) => p.includes("api.telegram.org"))).toBe(true);
  });

  it("fails on a scheme-less external host", () => {
    const problems = problemsOf([
      [
        ".github/workflows/ci.yml",
        ciLikeWorkflow("      - run: curl //status.example.com/health\\n"),
      ],
    ]);
    expect(problems.some((p) => p.includes("status.example.com"))).toBe(true);
  });

  it("fails on an unknown non-loopback host and on a non-loopback bind", () => {
    const problems = problemsOf([
      [
        ".github/workflows/ci.yml",
        ciLikeWorkflow(
          "      - run: curl https://status.example.com/health\n" +
            `      - run: curl http://${NON_LOOPBACK_IP}:9000/\n`
        ),
      ],
    ]);
    expect(problems.some((p) => p.includes("status.example.com"))).toBe(true);
    expect(problems.some((p) => p.includes(NON_LOOPBACK_IP))).toBe(true);
  });

  it("allows loopback URLs and tool-distribution hosts", () => {
    const problems = problemsOf([
      [
        ".github/workflows/gitleaks.yml",
        ciLikeWorkflow(
          '      - run: curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v1/g.tgz"\n' +
            "      - run: curl http://127.0.0.1:8792/healthz\n"
        ),
      ],
      [".github/workflows/extended-verification.yml", gatedWorkflow()],
    ]);
    expect(problems).toEqual([]);
  });

  it("fails when the gated workflow drops the secret-gate wiring", () => {
    const problems = problemsOf([
      [
        ".github/workflows/extended-verification.yml",
        gatedWorkflow({ liveNeeds: "[]", liveIf: "always()" }),
      ],
    ]);
    expect(problems.some((p) => p.includes("needs: secret-gate"))).toBe(true);
    expect(
      problems.some((p) => p.includes("needs.secret-gate.outputs.provider"))
    ).toBe(true);
  });

  it("fails when a credential env appears outside the gated jobs", () => {
    const problems = problemsOf([
      [
        ".github/workflows/extended-verification.yml",
        `${gatedWorkflow()}  storage-stress:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm stress\n        env:\n          AI_API_KEY: ${ghExpr("secrets.AI_API_KEY")}\n`,
      ],
    ]);
    expect(problems.some((p) => p.includes("storage-stress"))).toBe(true);
  });

  it("fails when extended-verification.yml is missing", () => {
    const problems = problemsOf([
      [".github/workflows/ci.yml", ciLikeWorkflow()],
    ]);
    expect(problems.some((p) => p.includes("is missing"))).toBe(true);
  });
});
