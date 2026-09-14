const CHECKOUT_ACTION =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const PNPM_ACTION =
  "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413";
const NODE_ACTION =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const githubExpression = (name) => `\${{ ${name} }}`;
const SHA = githubExpression("github.sha");
const TOKEN = githubExpression("secrets.GITHUB_TOKEN");
const WRITE_PERMISSIONS = ["contents", "pull-requests", "id-token"];
const PUBLISH_RUN = "pnpm tegami ci";

const ownKeysEqual = (value, expected) => {
  const keys = Object.keys(value ?? {}).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, i) => key === [...expected].sort()[i])
  );
};

const policyKeys = (value) =>
  Object.keys(value ?? {}).filter(
    (key) => key !== "continue-on-error" || value[key] !== false
  );

const objectEquals = (value, expected) =>
  ownKeysEqual(value, Object.keys(expected)) &&
  Object.entries(expected).every(
    ([key, expectedValue]) => value[key] === expectedValue
  );

const stepEquals = (step, expected) =>
  ownKeysEqual(
    Object.fromEntries(policyKeys(step).map((key) => [key, step[key]])),
    Object.keys(expected)
  ) &&
  Object.entries(expected).every(([key, value]) =>
    typeof value === "object"
      ? objectEquals(step[key], value)
      : step[key] === value
  );

const EXPECTED_STEPS = [
  {
    name: "Checkout",
    uses: CHECKOUT_ACTION,
    with: { "fetch-depth": 0, ref: SHA },
  },
  { name: "Setup pnpm", uses: PNPM_ACTION },
  {
    name: "Setup Node.js",
    uses: NODE_ACTION,
    with: {
      "node-version-file": ".node-version",
      "registry-url": "https://registry.npmjs.org",
      "package-manager-cache": false,
    },
  },
  { name: "Install dependencies", run: "pnpm install --frozen-lockfile" },
  { name: "Build release artifacts", run: "pnpm build" },
  { name: "Verify release artifacts", run: "pnpm verify:release" },
  {
    name: "Version or publish packages",
    run: PUBLISH_RUN,
    env: { GITHUB_TOKEN: TOKEN },
  },
];

export function publishStepLocations(jobs, workflowPath, problems) {
  const locations = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const [publishIndex, step] of (job?.steps ?? []).entries()) {
      if (step?.run === PUBLISH_RUN) {
        locations.push({ jobId, job, publishIndex });
      }
    }
  }
  if (locations.length === 0) {
    problems.push(
      `${workflowPath} has no publish step; expected ${PUBLISH_RUN}`
    );
  } else if (locations.length > 1) {
    problems.push(
      `${workflowPath} must have exactly one canonical publish step (${PUBLISH_RUN})`
    );
  }
  return locations;
}

export function validationJobProblems(jobId, job, workflowPath) {
  const problems = [];
  if (![undefined, false].includes(job?.["continue-on-error"])) {
    problems.push(`${workflowPath} validation job "${jobId}" must fail closed`);
  }
  return problems;
}

export function calledWorkflowProblems(doc, workflowPath) {
  const problems = [];
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
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
    for (const step of job?.steps ?? []) {
      if (![undefined, false].includes(step?.["continue-on-error"])) {
        problems.push(
          `${workflowPath} runner job "${jobId}" step "${step?.name ?? "?"}" must fail closed`
        );
      }
    }
  }
  return problems;
}

export function publishJobProblems({
  jobId,
  job,
  validationIds,
  workflowPath,
}) {
  const problems = [];
  if (job?.needs !== validationIds[0]) {
    problems.push(
      `${workflowPath} job "${jobId}" publishes without needing only the complete validation job`
    );
  }
  const permissions = job?.permissions ?? {};
  for (const permission of WRITE_PERMISSIONS) {
    if (permissions[permission] !== "write") {
      problems.push(
        `${workflowPath} publish job "${jobId}" lacks ${permission}: write`
      );
    }
  }
  if (
    Object.keys(permissions).some((key) => !WRITE_PERMISSIONS.includes(key))
  ) {
    problems.push(
      `${workflowPath} publish job "${jobId}" has permission outside the publish allowlist`
    );
  }
  if (
    !objectEquals(
      permissions,
      Object.fromEntries(WRITE_PERMISSIONS.map((key) => [key, "write"]))
    )
  ) {
    problems.push(
      `${workflowPath} publish job "${jobId}" has non-canonical permissions`
    );
  }
  if (job?.if !== undefined) {
    problems.push(
      `${workflowPath} publish job "${jobId}" must rely on successful-needs`
    );
  }
  const expectedJobKeys = [
    "name",
    "needs",
    "runs-on",
    "timeout-minutes",
    "permissions",
    "steps",
  ];
  if (
    !ownKeysEqual(
      Object.fromEntries(policyKeys(job).map((key) => [key, job[key]])),
      expectedJobKeys
    ) ||
    job.name !== "Version and publish" ||
    job["runs-on"] !== "ubuntu-latest" ||
    job["timeout-minutes"] !== 15
  ) {
    problems.push(
      `${workflowPath} publish job "${jobId}" must use the strict job allowlist`
    );
  }
  if ((job?.steps ?? []).length !== EXPECTED_STEPS.length) {
    problems.push(
      `${workflowPath} publish job "${jobId}" must contain only the canonical steps`
    );
  }
  for (const [index, expected] of EXPECTED_STEPS.entries()) {
    if (!stepEquals(job?.steps?.[index], expected)) {
      problems.push(
        `${workflowPath} publish job "${jobId}" step ${index + 1} is not canonical`
      );
    }
  }
  if (!(job?.steps ?? []).some((step) => stepEquals(step, EXPECTED_STEPS[4]))) {
    problems.push(
      `${workflowPath} publish job "${jobId}" does not build artifacts`
    );
  }
  if (!(job?.steps ?? []).some((step) => stepEquals(step, EXPECTED_STEPS[5]))) {
    problems.push(
      `${workflowPath} publish job "${jobId}" does not verify artifacts`
    );
  }
  return problems;
}
