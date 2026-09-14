const BUILD_STEP = /^\s*pnpm\s+build\s*$/;
const VERIFY_STEP = /^\s*pnpm\s+verify:release\s*$/;
const WRITE_PERMISSIONS = ["contents", "pull-requests", "id-token"];
const PUBLISH_STEP = /^\s*pnpm\s+tegami\s+ci\s*$/;
const TEGAMI_PUBLISH = /\btegami\s+ci\b/;
const PACKAGE_PUBLISH = /\b(?:npm|pnpm)\b[^\n;&|]*\bpublish\b/;

export function containsPublishCommand(command) {
  const joined = command.replace(/\\\r?\n[\t ]*/g, " ");
  return TEGAMI_PUBLISH.test(joined) || PACKAGE_PUBLISH.test(joined);
}

function needsJob(job, dependency) {
  return [job?.needs ?? []].flat().map(String).includes(dependency);
}

function hasRequiredStep(job, publishIndex, pattern) {
  return (job?.steps ?? [])
    .slice(0, publishIndex)
    .some(
      (step) =>
        pattern.test(String(step?.run ?? "")) &&
        step?.if === undefined &&
        [undefined, false].includes(step?.["continue-on-error"])
    );
}

export function publishStepLocations(jobs, workflowPath, problems) {
  const locations = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const [publishIndex, step] of (job?.steps ?? []).entries()) {
      if (typeof step?.run !== "string") {
        continue;
      }
      if (PUBLISH_STEP.test(step.run)) {
        locations.push({ jobId, job, publishIndex });
      } else if (containsPublishCommand(step.run)) {
        problems.push(
          `${workflowPath} job "${jobId}" contains an unrecognized publish command`
        );
      }
    }
  }
  return locations;
}

export function publishJobProblems({
  jobId,
  job,
  validationIds,
  publishIndex,
  workflowPath,
}) {
  const problems = [];
  const publishStep = job?.steps?.[publishIndex];
  if (!validationIds.some((id) => needsJob(job, id))) {
    problems.push(
      `${workflowPath} job "${jobId}" publishes without needing the complete validation job`
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
    Object.keys(permissions).some(
      (permission) => !WRITE_PERMISSIONS.includes(permission)
    )
  ) {
    problems.push(
      `${workflowPath} publish job "${jobId}" has permission outside the publish allowlist`
    );
  }
  if (job?.if !== undefined) {
    problems.push(
      `${workflowPath} publish job "${jobId}" must rely on the default successful-needs condition`
    );
  }
  if (![undefined, false].includes(job?.["continue-on-error"])) {
    problems.push(`${workflowPath} publish job "${jobId}" must fail closed`);
  }
  if (job?.strategy !== undefined) {
    problems.push(
      `${workflowPath} publish job "${jobId}" must run exactly once without a strategy`
    );
  }
  if (publishStep?.if !== undefined) {
    problems.push(
      `${workflowPath} publish step must rely on the default successful-step condition`
    );
  }
  if (![undefined, false].includes(publishStep?.["continue-on-error"])) {
    problems.push(`${workflowPath} publish step must fail closed`);
  }
  if (!hasRequiredStep(job, publishIndex, BUILD_STEP)) {
    problems.push(
      `${workflowPath} publish job "${jobId}" does not build artifacts on its fresh runner before publishing`
    );
  }
  if (!hasRequiredStep(job, publishIndex, VERIFY_STEP)) {
    problems.push(
      `${workflowPath} publish job "${jobId}" does not verify fresh-runner artifacts before publishing`
    );
  }
  return problems;
}
