import { expect, it } from "vitest";
import { containsPublishCommand } from "./ci-publish-command.mjs";
import {
  ciWorkflow,
  replaceWorkflowSource,
} from "./ci-release-gating.fixture.mjs";
import { securityVisibilityProblems } from "./ci-release-gating.mjs";

function cleanPathProblems(command) {
  const workflow = replaceWorkflowSource(
    ciWorkflow(),
    "        run: pnpm test",
    `        run: |\n          ${command.replaceAll("\n", "\n          ")}`
  );
  return securityVisibilityProblems([workflow]);
}

function expectCleanPathPublication(command) {
  expect(containsPublishCommand(command)).toBe(true);
  expect(
    cleanPathProblems(command).some((problem) =>
      problem.includes("never publishes")
    )
  ).toBe(true);
}

it.each(["n\\\npm p\\\nub", "n\"\"pm p''ub", 'n"p"m pub', "pn\\\npm publish"])(
  "recognizes shell-tokenized publication: %s",
  expectCleanPathPublication
);

it.each([
  "command npm pub",
  "env RELEASE=true pnpm publish",
  "exec npm publ",
  "sudo npm publish",
])(
  "recognizes publication through a shell command wrapper: %s",
  expectCleanPathPublication
);

it.each(["bash -c 'npm publish'", "bash -lc 'npm publish'", "sh -c 'npm pub'"])(
  "recognizes publication delegated to a shell interpreter: %s",
  expectCleanPathPublication
);

it.each(["CI+=1 npm publish", "env CI+=1 pnpm publish"])(
  "recognizes publication after an append assignment: %s",
  expectCleanPathPublication
);

it.each(['echo "$(npm pub)"', "result=`pnpm publish`"])(
  "recognizes publication inside command substitution: %s",
  expectCleanPathPublication
);

it.each([
  'echo "npm publish is disabled"',
  'echo "status | npm publish is disabled"',
  "echo '$(npm pub)'",
  "# npm publish is disabled",
  "printf '%s\\n' 'pnpm publish'",
  "echo npm publish",
  "npm exec echo pub",
  "command -v npm pub",
  "bash -c 'echo npm publish'",
])("does not classify harmless text as publication: %s", (command) => {
  expect(containsPublishCommand(command)).toBe(false);
  expect(
    cleanPathProblems(command).some((problem) =>
      problem.includes("never publishes")
    )
  ).toBe(false);
});
