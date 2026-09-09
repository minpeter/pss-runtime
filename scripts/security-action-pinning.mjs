// Action-pinning invariants (VAL-SEC-038): every external `uses:` reference
// in every workflow under .github/workflows/ is pinned to a full 40-hex
// commit SHA with a trailing version comment on the same source line
// (`actions/checkout@3d3c42e5... # v7`). Static over committed files only:
// no network, no ports, no writes, no clock.
//
// Exemptions (documented policy):
// - Local composite actions (`uses: ./path/...`) are repository content,
//   reviewed in the same change that ships them; they are exempt from
//   SHA pinning by design.
// - No other exemption exists: `docker://` references are external and are
//   flagged (this repository uses none). Reusable-workflow job-level
//   `uses:` references are external and pinned like any action.
//
// Problems name the workflow file, the owning job/step (from the parsed
// YAML, falling back to the source line), and the offending reference.

import { parseWorkflowDocs } from "./workflow-docs.mjs";

// One `uses:` occurrence per source line: optional list dash, the reference
// (no whitespace or comment opener), and an optional trailing comment.
const USES_LINE =
  /(?:^\s*(?:-\s*)?uses:|[,{]\s*uses:)\s*(?<ref>[^\s,#}]+)(?:\s+#\s*(?<comment>[^\n,}]*?))?(?=\s*(?:[,}]|$))/gm;

// External-action pin shape: `<owner>/<repo>[@<path>]@<40-hex-sha>`.
const PINNED_REF = /^[^@\s]+@[0-9a-f]{40}$/;

// Trailing version comment shape: `# v7`, `# v6.0.10`, `# v0.15.0`.
const VERSION_COMMENT = /^v\d[\w.-]*/;

// Local composite actions are exempt (see the module header policy).
const LOCAL_PREFIX = "./";
const DOCKER_PREFIX = "docker://";

// Every `uses:` occurrence in a workflow source, with its trailing comment.
export function usesRefs(source) {
  const refs = [];
  for (const match of source.matchAll(USES_LINE)) {
    refs.push({
      ref: match.groups.ref,
      comment: match.groups.comment ?? "",
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return refs;
}

function stepDescriptor(jobName, step, index) {
  const stepLabel =
    typeof step?.name === "string" ? step.name : `#${index + 1}`;
  return `job "${jobName}" step "${stepLabel}"`;
}

// Map each parsed `uses:` value to its owning job/step descriptors, in
// document order, so a problem can name the step instead of just a line.
export function usesDescriptors(doc) {
  const descriptors = new Map();
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    if (typeof job?.uses === "string") {
      const list = descriptors.get(job.uses) ?? [];
      list.push(`job "${jobName}" (reusable workflow call)`);
      descriptors.set(job.uses, list);
    }
    for (const [index, step] of (job?.steps ?? []).entries()) {
      if (typeof step?.uses === "string") {
        const list = descriptors.get(step.uses) ?? [];
        list.push(stepDescriptor(jobName, step, index));
        descriptors.set(step.uses, list);
      }
    }
  }
  return descriptors;
}

function externalProblems(path, where, ref, comment) {
  const label = `${path} ${where} reference "${ref}"`;
  if (!PINNED_REF.test(ref)) {
    return [
      `${label} is not pinned to a full 40-hex commit SHA (unpinned tag/branch references are forbidden)`,
    ];
  }
  if (!VERSION_COMMENT.test(comment)) {
    return [
      `${label} lacks a trailing version comment on the uses line (\`@<40-hex-sha> # vX.Y.Z\`)`,
    ];
  }
  return [];
}

function workflowPinningProblems(path, source, doc) {
  const problems = [];
  const descriptors = usesDescriptors(doc);
  for (const { ref, comment, line } of usesRefs(source)) {
    if (ref.startsWith(LOCAL_PREFIX)) {
      continue; // local composite action: exempt by documented policy
    }
    const where = descriptors.get(ref)?.shift() ?? `line ${line}`;
    if (ref.startsWith(DOCKER_PREFIX)) {
      problems.push(
        `${path} ${where} reference "${ref}" is a docker:// action; only SHA-pinned git actions are permitted`
      );
      continue;
    }
    problems.push(...externalProblems(path, where, ref, comment));
  }
  return problems;
}

// Shipped-workflow invariant: every external `uses:` reference across all
// workflow files satisfies the pinning policy.
export function pinningProblems(workflows) {
  const problems = [];
  for (const { path, source, doc } of withDocs(workflows, problems)) {
    problems.push(...workflowPinningProblems(path, source, doc));
  }
  return problems;
}

function withDocs(workflows, problems) {
  const sources = new Map(workflows.map(({ path, source }) => [path, source]));
  return parseWorkflowDocs(workflows, problems).map(({ path, doc }) => ({
    path,
    doc,
    source: sources.get(path) ?? "",
  }));
}
