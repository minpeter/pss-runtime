import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { pnpmTokens, rootScripts } from "./governance-skills.mjs";

export const README_FILE = "README.md";
export const APP_README_FILE = "apps/coding-agent/README.md";
export const WORKER_AGENT_DOC = "docs/worker-agent.md";
export const RUNBOOKS_DIR = "docs/runbooks";
export const DEFERRED_DOC = "docs/deferred-controls.md";
export const SKILLS_DIR = ".factory/skills";

// Governance docs that always exist and are always scanned (VAL-GOV-051/052).
export const CORE_GOVERNANCE_DOCS = [
  README_FILE,
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  "docs/label-taxonomy.md",
];

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const ABSOLUTE_OR_ANCHOR = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;
const WORKER_AGENT_TARGET = /worker-agent\.md$/;

// External-only control terms (VAL-GOV-048) and disruptive local-action terms
// (VAL-GOV-050), each classified per line against deferral wording.
const CONTROL_TERMS =
  /branch protection|secret scan|analytics|sentry|pagerduty|progressive rollout|rollback|monitoring/i;
const DISRUPTIVE_TERMS = /npm publish|wrangler deploy|production|telegram/i;
const DEFERRAL_MARKER =
  /\b(?:deferred|external|out of scope|out-of-scope|not configured|cannot be verified|never|do not|don't|must not|forbidden|planned|advisory)\b/i;

// Strings the runtime quick start must keep / must never reintroduce
// (VAL-GOV-047, mirrored from scripts/runtime-docs.test.mjs).
const QUICK_START_REQUIRED = [
  'import { createAgent } from "@minpeter/pss-runtime"',
  "const agent = await createAgent({",
  'agent.thread("default")',
  "turn.events()",
];
const QUICK_START_FORBIDDEN = [
  "new Agent({",
  "agent.session(",
  "~/.pss/sessions",
];

// Milestone gate commands that must remain real root scripts (VAL-GOV-052).
export const GATE_SCRIPTS = [
  "lint",
  "typecheck",
  "test",
  "build",
  "coverage",
  "api:check",
  "verify:edge",
];

export function readDoc(path, root = ".") {
  return readFileSync(join(root, path), "utf8");
}

// Full governance documentation set: the core docs, every runbook, the
// deferred-controls list when present, and every repository skill.
export function governanceDocs(root = ".") {
  const docs = [...CORE_GOVERNANCE_DOCS];
  const runbookDir = join(root, RUNBOOKS_DIR);
  if (existsSync(runbookDir)) {
    for (const entry of readdirSync(runbookDir).sort()) {
      if (entry.endsWith(".md")) {
        docs.push(`${RUNBOOKS_DIR}/${entry}`);
      }
    }
  }
  if (existsSync(join(root, DEFERRED_DOC))) {
    docs.push(DEFERRED_DOC);
  }
  const skillsDir = join(root, SKILLS_DIR);
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir).sort()) {
      if (existsSync(join(skillsDir, entry, "SKILL.md"))) {
        docs.push(`${SKILLS_DIR}/${entry}/SKILL.md`);
      }
    }
  }
  return docs;
}

// Repo-relative markdown link targets in a document (VAL-GOV-051): external
// URLs, pure anchors, and root-absolute paths are out of scope.
export function relativeLinks(text) {
  const links = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const raw = match[1];
    if (ABSOLUTE_OR_ANCHOR.test(raw)) {
      continue;
    }
    const target = raw.split("#")[0];
    if (target !== "") {
      links.push(target);
    }
  }
  return [...new Set(links)];
}

// "doc -> target" pairs inside one document whose link does not resolve.
export function unresolvedLinksIn(doc, text, root = ".") {
  const bad = [];
  for (const target of relativeLinks(text)) {
    const resolved = normalize(join(dirname(doc), target));
    if (!existsSync(join(root, resolved))) {
      bad.push(`${doc} -> ${target}`);
    }
  }
  return bad;
}

// Every dangling relative link across the governance doc set (VAL-GOV-051).
export function unresolvedDocLinks(root = ".") {
  return governanceDocs(root).flatMap((doc) =>
    unresolvedLinksIn(doc, readDoc(doc, root), root)
  );
}

// Link targets in a document that cite the worker-agent doc (VAL-GOV-049).
export function workerAgentRefs(text) {
  return relativeLinks(text).filter((target) =>
    WORKER_AGENT_TARGET.test(target)
  );
}

// Unresolved runbook/skill citations of docs/worker-agent.md (VAL-GOV-049).
export function unresolvedWorkerAgentRefs(root = ".") {
  return governanceDocs(root)
    .filter((doc) => doc !== README_FILE)
    .flatMap((doc) =>
      workerAgentRefs(readDoc(doc, root))
        .filter(
          (target) =>
            !existsSync(join(root, normalize(join(dirname(doc), target))))
        )
        .map((target) => `${doc} -> ${target}`)
    );
}

// Lines whose classified terms carry no deferral wording (VAL-GOV-048/050).
export function claimHits(text, terms) {
  const hits = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (terms.test(line) && !DEFERRAL_MARKER.test(line)) {
      hits.push(line);
    }
  }
  return hits;
}

export function externalControlClaimHits(text) {
  return claimHits(text, CONTROL_TERMS);
}

export function disruptiveActionHits(text) {
  return claimHits(text, DISRUPTIVE_TERMS);
}

// Lines that mention an external-only control WITH deferral wording; the
// README boundary note exists only when at least one is present (VAL-GOV-048).
export function deferralNoteLines(text) {
  return text
    .split("\n")
    .filter((line) => CONTROL_TERMS.test(line) && DEFERRAL_MARKER.test(line));
}

// Quick-start contract problems in the root README (VAL-GOV-047).
export function quickStartProblems(text) {
  const problems = [];
  for (const token of QUICK_START_REQUIRED) {
    if (!text.includes(token)) {
      problems.push(`missing quick-start token: ${token}`);
    }
  }
  for (const token of QUICK_START_FORBIDDEN) {
    if (text.includes(token)) {
      problems.push(`forbidden legacy API string: ${token}`);
    }
  }
  return problems;
}

// App README contract problems (VAL-GOV-049).
export function appReadmeProblems(text) {
  const problems = [];
  for (const knob of ["PSS_THREAD_DIR", "PSS_THREAD_KEY"]) {
    if (!text.includes(knob)) {
      problems.push(`missing env knob documentation: ${knob}`);
    }
  }
  if (text.includes("~/.pss/sessions")) {
    problems.push("legacy ~/.pss/sessions reference");
  }
  return problems;
}

// pnpm tokens in one document that are not real root scripts (VAL-GOV-052).
export function unknownTokensIn(text, scripts) {
  return pnpmTokens(text).filter((token) => !scripts.has(token));
}

// "doc: pnpm <token>" pairs for every documented token missing from root
// package.json scripts (VAL-GOV-052).
export function unknownDocPnpmTokens(root = ".") {
  const scripts = rootScripts(root);
  return governanceDocs(root).flatMap((doc) =>
    unknownTokensIn(readDoc(doc, root), scripts).map(
      (token) => `${doc}: pnpm ${token}`
    )
  );
}

// Milestone gate scripts missing from root package.json (VAL-GOV-052).
export function missingGateScripts(root = ".") {
  const scripts = rootScripts(root);
  return GATE_SCRIPTS.filter((name) => !scripts.has(name));
}
