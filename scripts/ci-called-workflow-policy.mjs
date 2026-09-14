import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const githubExpression = (name) => `\${{ ${name} }}`;
const CHECKOUT_ACTION =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const PNPM_ACTION =
  "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413";
const NODE_ACTION =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const CANONICAL_STEPS_SHA256 =
  "343d4108ea9e5f4ad6305d5fbb6ee6dbe2690efedf14cfa1004dc7b6d5fb961b";

const NODE_24_STEPS = new Set([
  "Audit dependencies",
  "Check workspace version drift",
  "Check unused files and exports (Knip)",
  "Check duplicate code (jscpd)",
  "Check core package coverage",
  "Check extension package coverage",
  "Check Worker coverage",
  "Check bundle size budget",
  "Produce test-timing report",
]);
const CALLED_ACTION_STEPS = [
  { name: "Checkout", uses: CHECKOUT_ACTION, with: { "fetch-depth": 0 } },
  { name: "Setup pnpm", uses: PNPM_ACTION },
  {
    name: "Setup Node.js",
    uses: NODE_ACTION,
    with: { "node-version": githubExpression("matrix.node"), cache: "pnpm" },
  },
  {
    name: "Upload test-timing report",
    uses: UPLOAD_ACTION,
    if: githubExpression("always() && matrix.node == '24'"),
    with: {
      name: "test-timing",
      path: "report/test-timing.json",
      "retention-days": 7,
    },
  },
];

function policyStep(step) {
  if (step?.["continue-on-error"] !== false) {
    return step;
  }
  const { "continue-on-error": _ignored, ...rest } = step;
  return rest;
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  }
  return value;
}

function stepsDigest(steps) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(steps.map(policyStep))))
    .digest("hex");
}

function hasAllowedCondition(step) {
  return (
    step?.if === undefined ||
    (NODE_24_STEPS.has(step?.name) && step.if === "matrix.node == '24'") ||
    (step?.name === "Upload test-timing report" &&
      step.if === githubExpression("always() && matrix.node == '24'"))
  );
}

function actionProblems(step, jobId, workflowPath) {
  if (
    step?.uses === undefined ||
    CALLED_ACTION_STEPS.some((expected) =>
      isDeepStrictEqual(policyStep(step), expected)
    )
  ) {
    return [];
  }
  return [
    `${workflowPath} runner job "${jobId}" uses an unapproved action or action semantics`,
  ];
}

function calledJobProblems(jobId, job, workflowPath) {
  const problems = [];
  const steps = job?.steps ?? [];
  if (stepsDigest(steps) !== CANONICAL_STEPS_SHA256) {
    problems.push(
      `${workflowPath} runner job "${jobId}" must use the exact canonical validation steps`
    );
  }
  if (job?.defaults !== undefined) {
    problems.push(
      `${workflowPath} runner job "${jobId}" must not define execution defaults`
    );
  }
  if (
    !isDeepStrictEqual(job?.strategy, {
      "fail-fast": false,
      matrix: { node: ["24", "26"] },
    })
  ) {
    problems.push(
      `${workflowPath} runner job "${jobId}" must use the exact validation matrix`
    );
  }
  const checkouts = steps.filter((step) => step?.uses === CHECKOUT_ACTION);
  if (
    checkouts.length !== 1 ||
    !isDeepStrictEqual(policyStep(checkouts[0]), CALLED_ACTION_STEPS[0])
  ) {
    problems.push(
      `${workflowPath} runner job "${jobId}" must use exactly one canonical same-SHA checkout`
    );
  }
  if (
    typeof job?.["timeout-minutes"] !== "number" ||
    job["timeout-minutes"] <= 0
  ) {
    problems.push(
      `${workflowPath} runner job "${jobId}" needs a numeric timeout`
    );
  }
  if (![undefined, false].includes(job?.["continue-on-error"])) {
    problems.push(`${workflowPath} runner job "${jobId}" must fail closed`);
  }
  if (job?.if !== undefined) {
    problems.push(
      `${workflowPath} runner job "${jobId}" must not have a skip condition`
    );
  }
  for (const step of steps) {
    if (!hasAllowedCondition(step)) {
      problems.push(
        `${workflowPath} runner job "${jobId}" step "${step?.name ?? "?"}" has an unapproved condition`
      );
    }
    problems.push(...actionProblems(step, jobId, workflowPath));
    if (![undefined, false].includes(step?.["continue-on-error"])) {
      problems.push(
        `${workflowPath} runner job "${jobId}" step "${step?.name ?? "?"}" must fail closed`
      );
    }
  }
  return problems;
}

export function calledWorkflowProblems(doc, workflowPath) {
  const problems = [];
  if (doc?.defaults !== undefined) {
    problems.push(`${workflowPath} must not define execution defaults`);
  }
  problems.push(
    ...Object.entries(doc?.jobs ?? {}).flatMap(([jobId, job]) =>
      calledJobProblems(jobId, job, workflowPath)
    )
  );
  return problems;
}
