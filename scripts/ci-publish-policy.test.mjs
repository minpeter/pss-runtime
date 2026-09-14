import { expect, it } from "vitest";
import {
  githubExpression,
  releaseWorkflow,
} from "./ci-release-gating.fixture.mjs";
import { releaseSequencingProblems } from "./ci-release-gating.mjs";

// Publish must retain GitHub's default success propagation. These mutations
// model overrides that could otherwise publish after an earlier gate failed.
it.each([
  [`if: ${githubExpression("always()")}`, "successful-step"],
  ["continue-on-error: true", "fail closed"],
])("fails when the publish step adds %s", (override, error) => {
  const workflow = releaseWorkflow();
  workflow.source = workflow.source.replace(
    "      - run: pnpm tegami ci",
    `      - run: pnpm tegami ci\n        ${override}`
  );
  const problems = releaseSequencingProblems([workflow]);
  expect(problems.some((problem) => problem.includes(error))).toBe(true);
});

it("checks a second matching publish step for status overrides", () => {
  const workflow = releaseWorkflow();
  workflow.source = workflow.source.replace(
    "      - run: pnpm tegami ci",
    `      - run: pnpm tegami ci\n      - run: pnpm tegami ci\n        if: ${githubExpression("always()")}`
  );
  const problems = releaseSequencingProblems([workflow]);
  expect(problems.some((problem) => problem.includes("successful-step"))).toBe(
    true
  );
});
