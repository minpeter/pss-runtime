import { expect, it } from "vitest";
import {
  ciWorkflow,
  releaseWorkflow,
  replaceWorkflowSource,
} from "./ci-release-gating.fixture.mjs";
import { releaseSequencingProblems } from "./ci-release-gating.mjs";

function expectRejected(ci, fragment) {
  const problems = releaseSequencingProblems([releaseWorkflow(), ci]);
  expect(
    problems.some((problem) => problem.includes(fragment)),
    problems
  ).toBe(true);
}

it.each([
  [
    "workflow write-all",
    "permissions:\n  contents: read\n",
    "permissions: write-all\n",
    "exact read-only permissions",
  ],
  [
    "job permission override",
    "  checks:\n",
    "  checks:\n    permissions:\n      contents: write\n",
    "unapproved fields: permissions",
  ],
])("rejects called CI %s", (_label, from, to, error) => {
  const ci = replaceWorkflowSource(ciWorkflow(), from, to);
  expectRejected(ci, error);
});

it.each([
  ["alternate runner", "runs-on: ubuntu-latest", "runs-on: self-hosted"],
  [
    "container",
    "    timeout-minutes: 45\n",
    "    timeout-minutes: 45\n    container: attacker/validation-bypass\n",
  ],
])("rejects called CI runner context drift: %s", (_label, from, to) => {
  const ci = replaceWorkflowSource(ciWorkflow(), from, to);
  expectRejected(ci, "runner job");
});

it.each([
  ["empty", "jobs:\n  checks:", "jobs: {}\nignored:\n  checks:"],
  ["renamed", "  checks:\n", "  renamed:\n"],
  [
    "extra",
    "jobs:\n  checks:\n",
    "jobs:\n  extra:\n    uses: ./.github/workflows/ci.yml\n  checks:\n",
  ],
])("rejects a %s called CI job set", (_label, from, to) => {
  const ci = replaceWorkflowSource(ciWorkflow(), from, to);
  expectRejected(ci, "exactly the canonical jobs");
});

it("rejects release workflow write-all permissions", () => {
  const workflow = replaceWorkflowSource(
    releaseWorkflow(),
    "permissions: {}",
    "permissions: write-all"
  );
  const problems = releaseSequencingProblems([workflow, ciWorkflow()]);
  expect(
    problems.some((problem) =>
      problem.includes("deny workflow-level permissions")
    )
  ).toBe(true);
});

it.each([
  [
    "condition",
    "    name: Validate release SHA\n",
    "    name: Validate release SHA\n    if: false\n",
  ],
  [
    "permission",
    "    permissions:\n      contents: read\n",
    "    permissions:\n      contents: read\n      actions: read\n",
  ],
])("rejects validation caller %s drift", (_label, from, to) => {
  const workflow = replaceWorkflowSource(releaseWorkflow(), from, to);
  const problems = releaseSequencingProblems([workflow, ciWorkflow()]);
  expect(
    problems.some((problem) => problem.includes("strict caller allowlist"))
  ).toBe(true);
});

it("rejects an unapproved release workflow key", () => {
  const workflow = replaceWorkflowSource(
    releaseWorkflow(),
    "name: Release\n",
    "name: Release\nrun-name: unsafe drift\n"
  );
  const problems = releaseSequencingProblems([workflow, ciWorkflow()]);
  expect(problems.some((problem) => problem.includes("key allowlist"))).toBe(
    true
  );
});

it.each([
  [
    "release",
    releaseWorkflow(),
    "name: Release",
    "name: CI",
    "Release workflow name",
  ],
  ["called CI", ciWorkflow(), "name: CI", "name: Release", "CI workflow name"],
])("rejects %s workflow-name drift", (_label, workflow, from, to, error) => {
  const mutated = replaceWorkflowSource(workflow, from, to);
  const inputs = workflow.path.endsWith("release.yml")
    ? [mutated, ciWorkflow()]
    : [releaseWorkflow(), mutated];
  const problems = releaseSequencingProblems(inputs);
  expect(
    problems.some((problem) => problem.includes(error)),
    problems
  ).toBe(true);
});
