import { CI_WORKFLOW_PATH } from "./ci-fast-gate.mjs";
import { RELEASE_WORKFLOW } from "./ci-release-gating.mjs";

export const githubExpression = (name) => `\${{ ${name} }}`;
const ISOLATED_CI_GROUP = `ci-${githubExpression("github.workflow")}-${githubExpression("github.ref")}`;
const RELEASE_GROUP = `${githubExpression("github.workflow")}-${githubExpression("github.ref")}`;

export const DEFERRED_OK = [
  "## List",
  "",
  "### 1. Branch-protection enforcement",
  "",
  "Status: deferred. External-only; cannot be verified from repository files",
  "or local commands.",
  "",
  "## Other",
].join("\n");

export function releaseWorkflow({
  cancelInProgress = false,
  concurrencyGroup = RELEASE_GROUP,
  needs = "validate",
  publishIf,
  publishPermissions = "contents: write\n      pull-requests: write\n      id-token: write",
  publishRun = "pnpm tegami ci",
  validationPermissions = "contents: read",
  validationUses = "./.github/workflows/ci.yml",
} = {}) {
  const condition = publishIf ? `    if: ${publishIf}\n` : "";
  return {
    path: RELEASE_WORKFLOW,
    source: `name: Release\non:\n  push:\n    branches: [main]\nconcurrency:\n  group: ${concurrencyGroup}\n  cancel-in-progress: ${cancelInProgress}\npermissions: {}\njobs:\n  validate:\n    uses: ${validationUses}\n    permissions:\n      ${validationPermissions}\n  publish:\n    needs: ${needs}\n${condition}    permissions:\n      ${publishPermissions}\n    steps:\n      - run: pnpm build\n      - run: pnpm verify:release\n      - run: ${publishRun}\n`,
  };
}

export function ciWorkflow(
  extraRuns = [],
  concurrencyGroup = ISOLATED_CI_GROUP
) {
  const steps = ["pnpm test", ...extraRuns]
    .map((run) => `      - name: step\n        run: ${run}`)
    .join("\n");
  return {
    path: CI_WORKFLOW_PATH,
    source: `name: CI\non: [push, pull_request, workflow_call]\nconcurrency:\n  group: ${concurrencyGroup}\n  cancel-in-progress: true\njobs:\n  checks:\n    steps:\n${steps}\n`,
  };
}
