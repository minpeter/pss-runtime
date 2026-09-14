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

it("rejects duplicate publish steps even without a status override", () => {
  const workflow = releaseWorkflow();
  workflow.source = workflow.source.replace(
    "      - run: pnpm tegami ci",
    "      - run: pnpm tegami ci\n      - run: pnpm tegami ci"
  );
  const problems = releaseSequencingProblems([workflow]);
  expect(problems.some((problem) => problem.includes("exactly one"))).toBe(
    true
  );
});

it("rejects steps after publish and alternate publish commands", () => {
  const workflow = releaseWorkflow();
  workflow.source = workflow.source.replace(
    "      - run: pnpm tegami ci",
    "      - run: pnpm tegami ci\n      - run: pnpm publish --recursive"
  );
  const problems = releaseSequencingProblems([workflow]);
  expect(problems.some((problem) => problem.includes("unrecognized"))).toBe(
    true
  );
  expect(problems.some((problem) => problem.includes("final step"))).toBe(true);
});

it.each([
  "pnpm --filter @minpeter/pss-runtime publish",
  "npm --workspace packages/runtime publish",
])("rejects option-bearing alternate publish command: %s", (command) => {
  const workflow = releaseWorkflow();
  workflow.source = workflow.source.replace(
    "      - run: pnpm build",
    `      - run: ${command}\n      - run: pnpm build`
  );
  const problems = releaseSequencingProblems([workflow]);
  expect(problems.some((problem) => problem.includes("unrecognized"))).toBe(
    true
  );
});

it("rejects a strategy that would execute the publish job more than once", () => {
  const workflow = releaseWorkflow();
  workflow.source = workflow.source.replace(
    "  publish:\n",
    "  publish:\n    strategy:\n      matrix:\n        registry: [one, two]\n"
  );
  const problems = releaseSequencingProblems([workflow]);
  expect(problems.some((problem) => problem.includes("exactly once"))).toBe(
    true
  );
});

it.each(["true", githubExpression("true")])(
  "rejects an expression-capable artifact gate override %s",
  (value) => {
    const workflow = releaseWorkflow();
    workflow.source = workflow.source.replace(
      "      - run: pnpm build",
      `      - run: pnpm build\n        continue-on-error: ${value}`
    );
    const problems = releaseSequencingProblems([workflow]);
    expect(problems.some((problem) => problem.includes("does not build"))).toBe(
      true
    );
  }
);

it("accepts literal false on fail-closed artifact gates", () => {
  const workflow = releaseWorkflow();
  workflow.source = workflow.source
    .replace(
      "      - run: pnpm build",
      "      - run: pnpm build\n        continue-on-error: false"
    )
    .replace(
      "      - run: pnpm verify:release",
      "      - run: pnpm verify:release\n        continue-on-error: false"
    );
  expect(releaseSequencingProblems([workflow])).toEqual([]);
});

it("rejects a job-level continue-on-error override", () => {
  const workflow = releaseWorkflow();
  workflow.source = workflow.source.replace(
    "  publish:\n",
    `  publish:\n    continue-on-error: ${githubExpression("true")}\n`
  );
  const problems = releaseSequencingProblems([workflow]);
  expect(
    problems.some((problem) =>
      problem.includes('job "publish" must fail closed')
    )
  ).toBe(true);
});
