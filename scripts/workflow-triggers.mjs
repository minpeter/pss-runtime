// Shared bounded-trigger invariant for the security workflows
// (security-codeql.mjs, security-gitleaks.mjs): triggers stay inside the
// bounded set and a push trigger is always bounded to the main branch.

import { triggerSet } from "./flaky-ci.mjs";

// Bounded trigger set for security workflows (VAL-SEC-028/030).
const ALLOWED_TRIGGERS = new Set([
  "push",
  "pull_request",
  "schedule",
  "workflow_dispatch",
]);

export function boundedTriggerProblems(path, doc) {
  const triggers = triggerSet(doc?.on);
  const problems = [];
  if (triggers.length === 0) {
    problems.push(`${path} declares no triggers`);
    return problems;
  }
  for (const trigger of triggers) {
    if (!ALLOWED_TRIGGERS.has(trigger)) {
      problems.push(
        `${path} triggers on "${trigger}", outside the bounded set {push, pull_request, schedule, workflow_dispatch}`
      );
    }
  }
  // A push trigger must be bounded to the main branch, never every branch.
  if (
    triggers.includes("push") &&
    (!Array.isArray(doc?.on?.push?.branches) ||
      doc.on.push.branches.length !== 1 ||
      doc.on.push.branches[0] !== "main")
  ) {
    problems.push(
      `${path} push trigger is not bounded exactly to the main branch`
    );
  }
  return problems;
}
