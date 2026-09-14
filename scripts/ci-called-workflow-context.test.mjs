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
