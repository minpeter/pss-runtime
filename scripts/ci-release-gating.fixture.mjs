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

export function replaceRequiredText(source, from, to) {
  if (!source.includes(from)) {
    throw new Error(`missing mutation target: ${from}`);
  }
  const replaced = source.replace(from, to);
  if (replaced === source) {
    throw new Error(`mutation made no replacement: ${from}`);
  }
  return replaced;
}

export function replaceWorkflowSource(workflow, from, to) {
  return {
    ...workflow,
    source: replaceRequiredText(workflow.source, from, to),
  };
}

export function releaseWorkflow({
  cancelInProgress = false,
  concurrencyGroup = RELEASE_GROUP,
  needs = "validate",
  publishIf,
  publishPermissions = "contents: write\n      pull-requests: write\n      id-token: write",
  publishRun = "pnpm tegami ci",
  validationContinueOnError,
  validationPermissions = "contents: read",
  validationUses = "./.github/workflows/ci.yml",
} = {}) {
  const condition = publishIf ? `    if: ${publishIf}\n` : "";
  const validationOverride =
    validationContinueOnError === undefined
      ? ""
      : `    continue-on-error: ${validationContinueOnError}\n`;
  return {
    path: RELEASE_WORKFLOW,
    source: `name: Release\non:\n  push:\n    branches: [main]\nconcurrency:\n  group: ${concurrencyGroup}\n  cancel-in-progress: ${cancelInProgress}\npermissions: {}\njobs:\n  validate:\n    name: Validate release SHA\n    uses: ${validationUses}\n    permissions:\n      ${validationPermissions}\n${validationOverride}  publish:\n    name: Version and publish\n    needs: ${needs}\n${condition}    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    permissions:\n      ${publishPermissions}\n    steps:\n      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          fetch-depth: 0\n          ref: ${githubExpression("github.sha")}\n      - name: Setup pnpm\n        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413\n      - name: Setup Node.js\n        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020\n        with:\n          node-version-file: .node-version\n          registry-url: https://registry.npmjs.org\n          package-manager-cache: false\n      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n      - name: Build release artifacts\n        run: pnpm build\n      - name: Verify release artifacts\n        run: pnpm verify:release\n      - name: Version or publish packages\n        run: ${publishRun}\n        env:\n          GITHUB_TOKEN: ${githubExpression("secrets.GITHUB_TOKEN")}\n`,
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
    source: `name: CI\non: [push, pull_request, workflow_call]\nconcurrency:\n  group: ${concurrencyGroup}\n  cancel-in-progress: true\njobs:\n  checks:\n    timeout-minutes: 45\n    strategy:\n      fail-fast: false\n      matrix:\n        node: ["24", "26"]\n    steps:\n      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          fetch-depth: 0\n${steps}\n`,
  };
}
