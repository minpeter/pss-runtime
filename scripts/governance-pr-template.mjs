import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PR_TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";
export const CONTRIBUTING_PATH = "CONTRIBUTING.md";

// The two published packages a Tegami entry may target.
export const PUBLISHED_PACKAGES = [
  "npm:@minpeter/pss-runtime",
  "npm:@minpeter/pss-coding-agent",
];

// A level-2+ ATX heading line (`## ...`); a bare `#` title does not qualify.
const SUBHEADING = /^##\s+\S/m;

// Heading text of any level, captured for anchor matching.
const HEADING_LINE = /^#{1,6}\s+(.*)$/;

// `**bold**` label spans, matched globally within a line.
const BOLD_LABEL = /\*\*(.+?)\*\*/g;

const VERIFICATION_ANCHOR = /verif/;
const EVIDENCE_LOCATION = /\.omo\/evidence\//;
const TEGAMI_ENTRY = /\.tegami\/YYYY-MM-DD-/;
const PATCH_DEFAULT = /\bpatch\b/i;
const TEGAMI_COMMAND = /pnpm\s+check:tegami-notes/;

// Instructions the template must never carry (mirrors the VAL-GOV-018 scan).
const UNSAFE_PATTERN =
  /npm publish|pnpm publish|NPM_TOKEN|push.*main|skip ci|--no-verify/i;

// Markdown link target extractor: the path inside `](...)`.
const MARKDOWN_LINK = /\]\(([^)]+)\)/g;
const TEMPLATE_LINK = /PULL_REQUEST_TEMPLATE/i;
const LEADING_DOT_SLASH = /^\.\//;

export function readFile(path) {
  return readFileSync(path, "utf8");
}

export function hasSubheading(text) {
  return SUBHEADING.test(text);
}

// Section anchors are heading texts and `**bold**` labels, lowercased, so a
// section can be located by heading OR label wording without pinning phrasing.
export function sectionAnchors(text) {
  const anchors = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(HEADING_LINE);
    if (heading) {
      anchors.push(heading[1].toLowerCase());
    }
    for (const bold of line.matchAll(BOLD_LABEL)) {
      anchors.push(bold[1].toLowerCase());
    }
  }
  return anchors;
}

export function hasSection(text, regex) {
  return sectionAnchors(text).some((anchor) => regex.test(anchor));
}

// (b) verification must reference the live-surface QA AND the evidence location.
export function hasVerificationSection(text) {
  return hasSection(text, VERIFICATION_ANCHOR) && EVIDENCE_LOCATION.test(text);
}

export function referencesTegamiEntry(text) {
  return TEGAMI_ENTRY.test(text);
}

export function referencesBothPackages(text) {
  return PUBLISHED_PACKAGES.every((pkg) => text.includes(pkg));
}

export function referencesPatchDefault(text) {
  return PATCH_DEFAULT.test(text);
}

export function referencesTegamiCommand(text) {
  return TEGAMI_COMMAND.test(text);
}

export function findUnsafeInstructions(text) {
  return text.split("\n").filter((line) => UNSAFE_PATTERN.test(line));
}

export function rootScripts(repoRoot = ".") {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  return pkg.scripts ?? {};
}

// Markdown link targets in CONTRIBUTING that point at the PR template.
export function citedTemplatePaths(contributingText) {
  const cited = [];
  for (const match of contributingText.matchAll(MARKDOWN_LINK)) {
    const target = match[1].split("#")[0].trim();
    if (TEMPLATE_LINK.test(target)) {
      cited.push(target);
    }
  }
  return cited;
}

// A CONTRIBUTING-relative link resolves from the repo root (CONTRIBUTING.md
// lives at the root), so `.github/...` and `./.github/...` resolve alike.
export function templateReferenceResolves(target, repoRoot = ".") {
  const clean = target.replace(LEADING_DOT_SLASH, "");
  return existsSync(join(repoRoot, clean));
}
