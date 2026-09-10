import { describe, expect, it } from "vitest";
import { readWorkflows } from "./report-hygiene.mjs";
import {
  pinningProblems,
  usesDescriptors,
  usesRefs,
} from "./security-action-pinning.mjs";

// Global action-pinning policy (VAL-SEC-038): every external `uses:`
// reference in every workflow file — the fast gate (ci.yml), extended
// verification, the security workflows (CodeQL, gitleaks, ZAP), and the
// pre-existing release.yml — is pinned to a full 40-hex commit SHA with a
// trailing version comment. Local composite actions (`uses: ./...`) are the
// only exemption, documented in scripts/security-action-pinning.mjs. All
// checks are static over committed files and pure fixtures.

const CHECKOUT_V7 = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const PNPM_V6 = "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413";
const NODE_V7 = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const CODEQL_V4 = "cdf488f595d80d6e07e03d4674febd5ab45fa938";

function workflow({ steps = [], extraSteps = "" } = {}) {
  const stepLines = steps
    .map((step) => `      - name: ${step.name}\n        uses: ${step.uses}\n`)
    .join("");
  return `name: fixture
on: push
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
${stepLines}${extraSteps}`;
}

function problemsOf(path, source) {
  return pinningProblems([{ path, source }]);
}

describe("pinning: shipped workflows are fully SHA-pinned (VAL-SEC-038)", () => {
  it("every workflow file passes the pinning policy", () => {
    expect(pinningProblems(readWorkflows())).toEqual([]);
  });

  it("the shipped CodeQL workflow pins init and analyze to v4.37.9", () => {
    const codeql = readWorkflows().find(({ path }) =>
      path.endsWith("codeql.yml")
    );
    expect(
      usesRefs(codeql.source)
        .filter(({ ref }) => ref.startsWith("github/codeql-action/"))
        .map(({ ref, comment }) => ({ ref, comment }))
    ).toEqual([
      { ref: `github/codeql-action/init@${CODEQL_V4}`, comment: "v4.37.9" },
      { ref: `github/codeql-action/analyze@${CODEQL_V4}`, comment: "v4.37.9" },
    ]);
  });

  it("the shipped release.yml pins all three bootstrap actions", () => {
    const release = readWorkflows().find(({ path }) =>
      path.endsWith("release.yml")
    );
    expect(release.source).toContain(`${CHECKOUT_V7} # v7`);
    expect(release.source).toContain(`${PNPM_V6} # v6.1.0`);
    expect(release.source).toContain(`${NODE_V7} # v7`);
    expect(release.source).not.toContain("actions/checkout@v7");
  });

  it("enumerates every uses: line including reusable-workflow calls", () => {
    const source = workflow({
      steps: [{ name: "Checkout", uses: `${CHECKOUT_V7} # v7` }],
    });
    expect(usesRefs(source)).toHaveLength(1);
  });
});

describe("pinning: unpinned references fail naming file, step, and reference", () => {
  it("flags a flow-style action reference", () => {
    const source =
      "name: fixture\non: push\njobs:\n  checks:\n    runs-on: ubuntu-latest\n    steps: [{ uses: actions/checkout@v4 }]\n";
    const problems = problemsOf("fixture.yml", source);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("actions/checkout@v4");
  });

  it("flags a tag-pinned checkout in a ci-style workflow", () => {
    const problems = problemsOf(
      ".github/workflows/ci.yml",
      workflow({ steps: [{ name: "Checkout", uses: "actions/checkout@v4" }] })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ci.yml");
    expect(problems[0]).toContain('step "Checkout"');
    expect(problems[0]).toContain('"actions/checkout@v4"');
  });

  it("flags every unpinned bootstrap reference in a release.yml fixture", () => {
    const source = workflow({
      steps: [
        { name: "Checkout", uses: "actions/checkout@v7" },
        { name: "Setup pnpm", uses: "pnpm/action-setup@v6.0.10" },
        { name: "Setup Node.js", uses: "actions/setup-node@v7" },
      ],
    });
    const problems = problemsOf(".github/workflows/release.yml", source);
    expect(problems).toHaveLength(3);
    for (const ref of [
      "actions/checkout@v7",
      "pnpm/action-setup@v6.0.10",
      "actions/setup-node@v7",
    ]) {
      expect(
        problems.some(
          (p) => p.includes("release.yml") && p.includes(`"${ref}"`)
        )
      ).toBe(true);
    }
    expect(problems.some((p) => p.includes('step "Setup Node.js"'))).toBe(true);
  });

  it("flags a SHA pin without the trailing version comment", () => {
    const problems = problemsOf(
      "fixture.yml",
      workflow({ steps: [{ name: "Checkout", uses: CHECKOUT_V7 }] })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("version comment");
  });

  it("flags a short (non-40-hex) SHA pin", () => {
    const problems = problemsOf(
      "fixture.yml",
      workflow({
        steps: [{ name: "Checkout", uses: "actions/checkout@3d3c42e5 # v7" }],
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("40-hex");
  });

  it("flags an unpinned reusable-workflow job call", () => {
    const source = `name: fixture
on: push
jobs:
  delegate:
    uses: octo/repo/.github/workflows/shared.yml@main
`;
    const problems = problemsOf("fixture.yml", source);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('job "delegate"');
    expect(problems[0]).toContain("@main");
  });

  it("flags a docker:// action reference", () => {
    const problems = problemsOf(
      "fixture.yml",
      workflow({
        steps: [{ name: "Scan", uses: "docker://alpine:3.20" }],
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docker://");
  });

  it("reports a parse error for invalid YAML instead of crashing", () => {
    const problems = problemsOf("broken.yml", "on: [unclosed\n");
    expect(problems.some((p) => p.includes("parse error"))).toBe(true);
  });
});

describe("pinning: documented exemptions (VAL-SEC-038)", () => {
  it("exempts local composite actions (uses: ./...) from pinning", () => {
    const source = workflow({
      steps: [
        { name: "Checkout", uses: `${CHECKOUT_V7} # v7` },
        { name: "Local tooling", uses: "./.github/actions/local-tooling" },
      ],
    });
    expect(problemsOf("fixture.yml", source)).toEqual([]);
  });

  it("maps parsed uses values to their job and step names", () => {
    const doc = {
      jobs: {
        checks: {
          steps: [{ name: "Checkout", uses: "actions/checkout@v4" }],
        },
      },
    };
    expect(usesDescriptors(doc).get("actions/checkout@v4")).toEqual([
      'job "checks" step "Checkout"',
    ]);
  });
});
