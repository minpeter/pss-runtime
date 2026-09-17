import { expect, it } from "vitest";
import {
  ciWorkflow,
  githubExpression,
  releaseWorkflow,
  replaceWorkflowSource,
} from "./ci-release-gating.fixture.mjs";
import { releaseSequencingProblems } from "./ci-release-gating.mjs";

function expectRejected(workflow, fragment = "canonical") {
  const problems = releaseSequencingProblems([
    workflow,
    ...(workflow.path.endsWith("release.yml") ? [ciWorkflow()] : []),
  ]);
  expect(
    problems.some((problem) => problem.includes(fragment)),
    problems
  ).toBe(true);
}

const BEFORE_BUILD =
  "      - name: Build release artifacts\n        run: pnpm build";
const VERIFY =
  "      - name: Verify release artifacts\n        run: pnpm verify:release";
const PUBLISH =
  "      - name: Version or publish packages\n        run: pnpm tegami ci";

it.each([
  "npm --workspace packages/runtime pub",
  "npm --workspace packages/runtime publ",
  "npm --workspace packages/runtime publi",
  "npm --workspace packages/runtime publis",
  "npm --loglevel verbose --workspace packages/runtime pub",
  "pnpm --filter @minpeter/pss-runtime publish",
])("rejects an alternate package command before publish: %s", (command) => {
  const workflow = replaceWorkflowSource(
    releaseWorkflow(),
    BEFORE_BUILD,
    `      - run: ${command}\n${BEFORE_BUILD}`
  );
  expectRejected(workflow, "canonical steps");
});

it.each([
  "./.github/actions/publish",
  "vendor/npm-publish@0123456789012345678901234567890123456789",
])("rejects a local or external publication action: %s", (uses) => {
  const workflow = replaceWorkflowSource(
    releaseWorkflow(),
    BEFORE_BUILD,
    `      - uses: ${uses}\n${BEFORE_BUILD}`
  );
  expectRejected(workflow, "canonical steps");
  const ci = replaceWorkflowSource(
    ciWorkflow(),
    "        run: pnpm test",
    `        uses: ${uses}`
  );
  expectRejected(ci, "unapproved action");
});

it("rejects a later alternate publish command", () => {
  const workflow = replaceWorkflowSource(
    releaseWorkflow(),
    PUBLISH,
    `${PUBLISH}\n      - run: npm pub`
  );
  expectRejected(workflow, "canonical steps");
});

it("requires verification to be byte-adjacent to publication", () => {
  const workflow = replaceWorkflowSource(
    releaseWorkflow(),
    VERIFY,
    `${VERIFY}\n      - run: rm -rf dist && pnpm build`
  );
  expectRejected(workflow, "canonical steps");
});

it.each([
  [BEFORE_BUILD, "does not build"],
  [VERIFY, "does not verify"],
])("rejects an omitted artifact gate", (gate, error) => {
  const workflow = replaceWorkflowSource(releaseWorkflow(), `${gate}\n`, "");
  expectRejected(workflow, error);
});

it.each(["if: false", "continue-on-error: true"])(
  "rejects a fail-open build gate: %s",
  (override) => {
    const workflow = replaceWorkflowSource(
      releaseWorkflow(),
      BEFORE_BUILD,
      `${BEFORE_BUILD}\n        ${override}`
    );
    expectRejected(workflow, "does not build");
  }
);

it.each(["true", '"false"', githubExpression("inputs.tolerate")])(
  "rejects validation caller continue-on-error %s",
  (value) => {
    expectRejected(
      releaseWorkflow({ validationContinueOnError: value }),
      "validation job"
    );
  }
);

it("accepts absent or literal false validation caller overrides", () => {
  expect(releaseSequencingProblems([releaseWorkflow(), ciWorkflow()])).toEqual(
    []
  );
  expect(
    releaseSequencingProblems([
      releaseWorkflow({ validationContinueOnError: false }),
      ciWorkflow(),
    ])
  ).toEqual([]);
});

it("accepts literal false on called runner jobs and steps", () => {
  const jobFalse = replaceWorkflowSource(
    ciWorkflow(),
    "  checks:\n",
    "  checks:\n    continue-on-error: false\n"
  );
  const stepFalse = replaceWorkflowSource(
    jobFalse,
    "        run: pnpm test",
    "        run: pnpm test\n        continue-on-error: false"
  );
  expect(releaseSequencingProblems([releaseWorkflow(), stepFalse])).toEqual([]);
});

it.each([
  ["job", "  checks:\n", "  checks:\n    continue-on-error: true\n"],
  [
    "step expression",
    "        run: pnpm test",
    `        run: pnpm test\n        continue-on-error: ${githubExpression("true")}`,
  ],
  [
    "step string false",
    "        run: pnpm test",
    '        run: pnpm test\n        continue-on-error: "false"',
  ],
])("rejects fail-open nested CI %s override", (_label, from, to) => {
  const ci = replaceWorkflowSource(ciWorkflow(), from, to);
  expectRejected(ci, "must fail closed");
});

it.each(["1", githubExpression("inputs.timeout")])(
  "requires exact timeout-minutes: 45 instead of %s",
  (timeout) => {
    const ci = replaceWorkflowSource(
      ciWorkflow(),
      "    timeout-minutes: 45\n",
      `    timeout-minutes: ${timeout}\n`
    );
    expectRejected(ci, "timeout-minutes: 45");
  }
);

it("rejects a failure-masked called validation command", () => {
  const ci = replaceWorkflowSource(
    ciWorkflow(),
    "        run: pnpm test",
    "        run: pnpm test || true"
  );
  expectRejected(ci, "exact canonical validation steps");
});

it("rejects a skip condition on a called validation gate", () => {
  const ci = replaceWorkflowSource(
    ciWorkflow(),
    "        if: github.event_name != 'pull_request' || matrix.node == '24'",
    "        if: false"
  );
  expectRejected(ci, "unapproved condition");
});

it("rejects a skip condition on a called runner job", () => {
  const ci = replaceWorkflowSource(
    ciWorkflow(),
    "  checks:\n",
    "  checks:\n    if: false\n"
  );
  expectRejected(ci, "skip condition");
});

it("requires the exact called validation matrix", () => {
  const ci = replaceWorkflowSource(
    ciWorkflow(),
    'node: ["24", "26"]',
    'node: ["26"]'
  );
  expectRejected(ci, "exact validation matrix");
});

it("rejects called CI checkout ref drift", () => {
  const ci = replaceWorkflowSource(
    ciWorkflow(),
    "          fetch-depth: 0",
    "          fetch-depth: 0\n          ref: main"
  );
  expectRejected(ci, "action semantics");
});

it("rejects release workflow run defaults", () => {
  const workflow = replaceWorkflowSource(
    releaseWorkflow(),
    "permissions: {}\n",
    "permissions: {}\ndefaults:\n  run:\n    working-directory: packages/runtime\n"
  );
  expectRejected(workflow, "execution defaults");
});

it.each([
  [
    "workflow",
    "permissions:\n  contents: read\n",
    'permissions:\n  contents: read\ndefaults:\n  run:\n    shell: "true {0}"\n',
    "execution defaults",
  ],
  [
    "job",
    "  checks:\n",
    '  checks:\n    defaults:\n      run:\n        shell: "true {0}"\n',
    "execution defaults",
  ],
])("rejects called CI %s", (_label, from, to, error) => {
  expectRejected(replaceWorkflowSource(ciWorkflow(), from, to), error);
});

it("restricts release triggers to pushes on main", () => {
  const workflow = replaceWorkflowSource(
    releaseWorkflow(),
    "on:\n  push:\n    branches: [main]",
    "on:\n  push:\n    branches: [main]\n  pull_request_target:"
  );
  expectRejected(workflow, "only on pushes to main");
});

it.each([
  ["trigger branch", `ref: ${githubExpression("github.sha")}`, "ref: main"],
  [
    "dynamic ref",
    `ref: ${githubExpression("github.sha")}`,
    `ref: ${githubExpression("inputs.ref")}`,
  ],
  [
    "checkout action",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/checkout@v7",
  ],
  ["checkout semantics", "fetch-depth: 0", "fetch-depth: 1"],
])("rejects publish checkout drift: %s", (_label, from, to) => {
  expectRejected(replaceWorkflowSource(releaseWorkflow(), from, to));
});
