import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  itemSections,
  linksDeferredDoc,
  REQUIRED_ITEMS,
  readDoc,
} from "./governance-deferred.mjs";
import { claimScanPaths } from "./governance-deferred-scan.mjs";
import {
  DEFERRED_DOC,
  README_FILE,
  RUNBOOKS_DIR,
} from "./governance-readme.mjs";

// Final-state deferred-control surfaces (VAL-CROSS-016): the README, the
// label taxonomy, and every runbook must point readers at the single
// deferred list instead of restating or claiming external-only controls.
export const LINK_SURFACES_ROOT = [README_FILE, "docs/label-taxonomy.md"];

const SINGLE_LIST_REF = `\`${DEFERRED_DOC}\``;
const FOLLOW_UP_LINE = /^- Follow-up boundary:/im;
const BOUNDARY_MARKER = /\b(?:deferred|external|pending)\b/i;

// CI-activation claim classifiers for the committed security workflows.
// A line that names gitleaks/CodeQL and claims an active/observed CI result
// fails unless it carries deferral wording (the workflows activate only on
// push; no local check may claim their activation).
const ACTIVATION_TERM = /\b(?:gitleaks|codeql)\b/i;
const RESULT_COMPLETION =
  /\b(?:is|are|was|were|has been|have been)\s+(?:now\s+|currently\s+|fully\s+)?(?:active|activated|enabled|configured|running|passing|green|deployed|verified|executing)\b/i;
const RESULT_OBSERVED = /\b(?:run|runs|scan)\s+(?:passed|passes|is green)\b/i;
const DEFERRAL =
  /\b(?:deferred|external|out[- ]of[- ]scope|not configured|cannot|planned|pending|advisory|never|no hosted|do not|don't|must not|would)\b/i;

const NATIVE_SCAN_HEADING = /native github secret-scanning settings/i;
const GITLEAKS_WORD = /gitleaks/i;
const PENDING_WORD = /\b(?:pending|deferred|next push)\b/i;
const NEVER_CLAIM_LOCAL = /never claim a local gitleaks result/i;
const SECURITY_RUNBOOK = "docs/runbooks/security-scan-failure-triage.md";

export function linkSurfaces(root = ".") {
  const surfaces = [...LINK_SURFACES_ROOT];
  const runbookDir = join(root, RUNBOOKS_DIR);
  for (const entry of readdirSync(runbookDir).sort()) {
    if (entry.endsWith(".md")) {
      surfaces.push(`${RUNBOOKS_DIR}/${entry}`);
    }
  }
  return surfaces;
}

// Pure per-surface check: one document either links the single deferred list
// or is reported.
export function surfaceLinkProblem(file, text) {
  return linksDeferredDoc(file, text)
    ? null
    : `${file}: does not link the single deferred list (${DEFERRED_DOC})`;
}

// Every final-doc surface links the single deferred list (VAL-CROSS-016).
export function deferralLinkProblems(root = ".") {
  return linkSurfaces(root).flatMap((file) => {
    const problem = surfaceLinkProblem(file, readDoc(file, root));
    return problem ? [problem] : [];
  });
}

// The follow-up bullet block: the "- Follow-up boundary:" line plus its
// indented continuation lines (docs wrap at ~76 columns).
const CONTINUATION = /^\s+\S/;
const LIST_ITEM = /^- /;

function followUpBlock(body) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => FOLLOW_UP_LINE.test(line));
  if (start === -1) {
    return null;
  }
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (LIST_ITEM.test(line) || !CONTINUATION.test(line)) {
      break;
    }
    block.push(line);
  }
  return block.join("\n");
}

// Per-item follow-up boundary problems (VAL-CROSS-016): every deferred item
// ends with an explicit follow-up boundary that references the single
// deferred list and carries deferral wording.
export function followUpBoundaryProblems(text) {
  const problems = [];
  for (const item of REQUIRED_ITEMS) {
    const section = itemSections(text).find((s) => item.heading.test(s.title));
    if (!section) {
      continue;
    }
    const block = followUpBlock(section.body);
    if (!block) {
      problems.push(`${item.key}: missing follow-up boundary line`);
      continue;
    }
    if (!block.includes(SINGLE_LIST_REF)) {
      problems.push(
        `${item.key}: follow-up boundary does not reference ${DEFERRED_DOC}`
      );
    }
    // Strip the list reference first: the path itself contains "deferred".
    if (!BOUNDARY_MARKER.test(block.replaceAll(SINGLE_LIST_REF, ""))) {
      problems.push(`${item.key}: follow-up boundary lacks deferral wording`);
    }
  }
  return problems;
}

// Lines claiming a committed security workflow's CI activation or observed
// result, without deferral wording (VAL-CROSS-016).
export function activationClaimHits(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        ACTIVATION_TERM.test(line) &&
        (RESULT_COMPLETION.test(line) || RESULT_OBSERVED.test(line)) &&
        !DEFERRAL.test(line)
    );
}

// CI result-label inspection across the final docs and workflow surfaces.
export function finalActivationHits(root = ".") {
  return claimScanPaths(root).flatMap((path) =>
    activationClaimHits(readDoc(path, root)).map((line) => `${path}: ${line}`)
  );
}

// The gitleaks/CodeQL CI activation note must stay worded as pending until a
// push makes a run observable (VAL-CROSS-016, orchestrator boundary).
export function gitleaksDeferralProblems(text, root = ".") {
  const problems = [];
  const section = itemSections(text).find((s) =>
    NATIVE_SCAN_HEADING.test(s.title)
  );
  const pendingLine = section?.body
    .split("\n")
    .find((line) => GITLEAKS_WORD.test(line) && PENDING_WORD.test(line));
  if (!pendingLine) {
    problems.push(
      "native-secret-scanning: no gitleaks line carries pending/deferred activation wording"
    );
  }
  const runbook = readDoc(SECURITY_RUNBOOK, root);
  if (!NEVER_CLAIM_LOCAL.test(runbook)) {
    problems.push(
      `${SECURITY_RUNBOOK}: lost the never-claim-local-gitleaks-result boundary`
    );
  }
  return problems;
}
