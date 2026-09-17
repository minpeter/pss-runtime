import { expect, it } from "vitest";
import {
  ciWorkflow,
  releaseWorkflow,
  replaceWorkflowSource,
} from "./ci-release-gating.fixture.mjs";
import { releaseSequencingProblems } from "./ci-release-gating.mjs";

function expectInheritedEnvironmentRejected(workflows) {
  const problems = releaseSequencingProblems(workflows);
  expect(
    problems.some((problem) => problem.includes("inherited environment")),
    problems
  ).toBe(true);
}

it("rejects inherited release workflow environment", () => {
  const release = replaceWorkflowSource(
    releaseWorkflow(),
    "permissions: {}\n",
    "permissions: {}\nenv:\n  BASH_ENV: .github/hooks/release.sh\n"
  );
  expectInheritedEnvironmentRejected([release, ciWorkflow()]);
});

it.each([
  [
    "workflow",
    "permissions:\n  contents: read\n",
    "permissions:\n  contents: read\nenv:\n  BASH_ENV: .github/hooks/ci.sh\n",
  ],
  [
    "runner job",
    "  validation:\n",
    "  validation:\n    env:\n      BASH_ENV: .github/hooks/ci.sh\n",
  ],
])("rejects inherited called CI %s environment", (_label, from, to) => {
  const ci = replaceWorkflowSource(ciWorkflow(), from, to);
  expectInheritedEnvironmentRejected([releaseWorkflow(), ci]);
});
