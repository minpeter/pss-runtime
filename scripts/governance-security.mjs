import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SECURITY_PATH = "SECURITY.md";

// Docs that must each carry a resolving link to the security policy.
export const LINKING_DOCS = ["README.md", "CONTRIBUTING.md"];

// The published packages the supported-scope section must name. Both are
// resolved against the workspace layout below, so a rename here without a
// matching package fails the scope check rather than passing silently.
export const PUBLISHED_PACKAGES = [
  "@minpeter/pss-runtime",
  "@minpeter/pss-coding-agent",
];

const HEADING_LINE = /^#{1,6}\s+(.*)$/;
const SCOPE_HEADING = /support|scope|affected|version/i;

// Restrict package resolution to the project scope so unrelated scoped tokens
// in code examples (e.g. `@ai-sdk/...`) are not mistaken for a workspace claim.
const PACKAGE_TOKEN = /@minpeter\/[a-z0-9][a-z0-9._-]*/gi;

// A markdown link whose target is the security policy (optionally `./`-prefixed
// or carrying an anchor). Used for the README/CONTRIBUTING link checks.
const SECURITY_LINK = /\]\((?:\.\/)?SECURITY\.md(?:#[^)]*)?\)/i;

const REPORT_BUTTON = /report a vulnerability/i;
const PRIVATE_REPORTING =
  /private vulnerability reporting|security\s*\**\s*tab/i;
const DISCLOSURE_RULE =
  /keep[^.\n]*private|private[^.\n]*until[^.\n]*fix|until a fix has shipped|coordinated[^.\n]*disclosure/i;

const REPRO = /minimal reproduction|reproduc|repro\b/i;
const AFFECTED_VERSION = /affected version|version affected|supported version/i;
const IMPACT = /impact/i;

// Personal-contact identities (email addresses) must not appear; reporting is
// GitHub-native only.
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// Credential-shaped literals that must never be committed.
const CREDENTIAL_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /NPM_TOKEN\s*[:=]/,
];

// Terms that would signal a bounty / response-SLA / external-service promise.
const CLAIM_TERMS = /\b(?:bounty|sla|guarantee(?:s|d)?|guaranteeing)\b/i;

// Negation / deferral wording. A line that hits a claim term but also carries
// one of these is classified as an allowed disclaimer, not a completion claim.
const DEFERRAL_MARKER =
  /\b(?:no|not|never|without|none|cannot|can't|don't|do not|does not|doesn't|isn't|aren't|won't|deferred|external|out of scope|out-of-scope|best-effort|best effort)\b/i;

export function readSecurity(root = ".") {
  return readFileSync(join(root, SECURITY_PATH), "utf8");
}

export function headingAnchors(text) {
  const anchors = [];
  for (const raw of text.split("\n")) {
    const heading = raw.trim().match(HEADING_LINE);
    if (heading) {
      anchors.push(heading[1].toLowerCase());
    }
  }
  return anchors;
}

export function hasHeading(text) {
  return headingAnchors(text).length > 0;
}

export function hasScopeSection(text) {
  return headingAnchors(text).some((anchor) => SCOPE_HEADING.test(anchor));
}

// Package `name` fields across every `package.json` directly under
// `packages/*` and `apps/*`. `@minpeter/pss-coding-agent` lives under `apps/`,
// so scope resolution must span both roots, not just `packages/`.
export function workspacePackageNames(root = ".") {
  const names = new Set();
  for (const area of ["packages", "apps"]) {
    const base = join(root, area);
    if (!existsSync(base)) {
      continue;
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifest = join(base, entry.name, "package.json");
      if (!existsSync(manifest)) {
        continue;
      }
      const { name } = JSON.parse(readFileSync(manifest, "utf8"));
      if (typeof name === "string" && name.length > 0) {
        names.add(name);
      }
    }
  }
  return names;
}

export function referencedPackages(text) {
  return [...new Set(text.match(PACKAGE_TOKEN) ?? [])];
}

// Project-scope package tokens named in the file that do not resolve to any
// workspace package name. Naming a nonexistent package lands here.
export function unresolvedPackages(text, root = ".") {
  const names = workspacePackageNames(root);
  return referencedPackages(text).filter((pkg) => !names.has(pkg));
}

export function missingPublishedPackages(text) {
  const referenced = new Set(referencedPackages(text));
  return PUBLISHED_PACKAGES.filter((pkg) => !referenced.has(pkg));
}

export function linksToSecurity(docText) {
  return SECURITY_LINK.test(docText);
}

export function securityLinkResolves(root = ".") {
  return existsSync(join(root, SECURITY_PATH));
}

export function hasReportingPath(text) {
  return REPORT_BUTTON.test(text) && PRIVATE_REPORTING.test(text);
}

export function hasDisclosureRule(text) {
  return DISCLOSURE_RULE.test(text);
}

export function missingRequestedDetails(text) {
  const missing = [];
  if (!REPRO.test(text)) {
    missing.push("minimal reproduction");
  }
  if (!AFFECTED_VERSION.test(text)) {
    missing.push("affected version");
  }
  if (!IMPACT.test(text)) {
    missing.push("impact");
  }
  return missing;
}

export function personalContactHits(text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => EMAIL.test(line))
    .map(({ line, index }) => `${index + 1}: ${line.trim()}`);
}

export function credentialHits(text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => CREDENTIAL_PATTERNS.some((re) => re.test(line)))
    .map(({ line, index }) => `${index + 1}: ${line.trim()}`);
}

// Lines that promise a bounty / response-SLA / external-service guarantee
// without a deferral marker. Deferral/negated wording is allowed; a bare
// completion claim is a hit.
export function claimHits(text) {
  const hits = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (CLAIM_TERMS.test(line) && !DEFERRAL_MARKER.test(line)) {
      hits.push(`${index + 1}: ${line}`);
    }
  });
  return hits;
}
