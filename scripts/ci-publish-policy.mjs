const BUILD_STEP = /^\s*pnpm\s+build\s*$/;
const VERIFY_STEP = /^\s*pnpm\s+verify:release\s*$/;
const WRITE_PERMISSIONS = ["contents", "pull-requests", "id-token"];

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
        step?.["continue-on-error"] !== true
    );
}

export function publishJobProblems({
  jobId,
  job,
  validationIds,
  publishIndex,
  workflowPath,
}) {
  const problems = [];
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
