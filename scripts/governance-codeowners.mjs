import { existsSync, readdirSync, readFileSync } from "node:fs";

// Repository areas that must each have at least one advisory ownership pattern.
export const REQUIRED_DIR_AREAS = [
  ".github",
  "packages/runtime",
  "apps/coding-agent",
  "apps/worker-agent",
  "extensions",
  "examples",
  "experimental",
  "docs",
  "scripts",
  "script",
  "assets",
];

// Valid CODEOWNERS owner tokens: @user, @org/team, or @org/* delegation only.
const OWNER_TOKEN =
  /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/(?:\*|[A-Za-z0-9._-]+))?$/;

// Ownership-scoped enforcement claims. A bare "enforce" (e.g. coverage
// baselines) is intentionally not a hit; only enforcement tied to review,
// approval, branch protection, or ownership counts.
const ENFORCEMENT_PATTERNS = [
  /required\s+review/i,
  /branch\s+protection/i,
  /enforced?\s+approvals?/i,
  /enforc\w*[^.\n]{0,40}(?:ownership|owners?|codeowners?|reviewers?|approvals?|merges?)/i,
  /(?:ownership|owners?|codeowners?)[^.\n]{0,40}enforc/i,
];

const DEFERRAL_MARKER =
  /\b(?:deferred|external|out of scope|advisory|not enforced|never enforced|no enforcement)\b/i;

const COMMENT = /#.*$/;
const WHITESPACE = /\s+/;
const AT_SIGN = /@/g;
const LEADING_SLASH = /^\//;
const TRAILING_GLOB = /\/\*\*$/;
const TRAILING_SLASH = /\/+$/;
const CODEOWNERS_MENTION = /CODEOWNERS/;
const LIST_BULLET = /^[-*]\s+/;
const BACKTICK = /`/g;

export function parseCodeowners(source) {
  const entries = [];
  const errors = [];
  source.split("\n").forEach((raw, index) => {
    const line = raw.replace(COMMENT, "").trim();
    if (line === "") {
      return;
    }
    const tokens = line.split(WHITESPACE);
    const [pattern, ...owners] = tokens;
    const lineNo = index + 1;
    if (owners.length === 0) {
      errors.push(`line ${lineNo}: pattern "${pattern}" has no owner token`);
    }
    for (const owner of owners) {
      const atCount = (owner.match(AT_SIGN) ?? []).length;
      if (!owner.startsWith("@") || atCount !== 1 || !OWNER_TOKEN.test(owner)) {
        errors.push(`line ${lineNo}: invalid owner token "${owner}"`);
      }
    }
    entries.push({ pattern, owners, lineNo });
  });
  return { entries, errors };
}

export function normalizePattern(pattern) {
  return pattern
    .replace(LEADING_SLASH, "")
    .replace(TRAILING_GLOB, "")
    .replace(TRAILING_SLASH, "");
}

export function findDuplicatePatterns(entries) {
  const counts = new Map();
  for (const { pattern } of entries) {
    const key = normalizePattern(pattern);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([key]) => key);
}

export function coversArea(entries, area) {
  const target = normalizePattern(area);
  if (target === "*") {
    return entries.some(({ pattern }) => normalizePattern(pattern) === "*");
  }
  return entries.some(({ pattern }) => {
    const p = normalizePattern(pattern);
    if (p === "*" || p === "") {
      return false;
    }
    return (
      p === target || p.startsWith(`${target}/`) || target.startsWith(`${p}/`)
    );
  });
}

// A top-level directory is owned when a non-fallback pattern's first path
// segment matches it. The root "*" fallback never counts as directory
// ownership, so a brand-new unowned top-level area is detectable.
export function coversTopLevelDir(entries, dir) {
  return entries.some(({ pattern }) => {
    const p = normalizePattern(pattern);
    if (p === "*" || p === "") {
      return false;
    }
    return p.split("/")[0] === dir;
  });
}

export function topLevelSourceDirs(root = ".") {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === ".github" || !name.startsWith("."))
    .filter((name) => name !== "node_modules");
}

export function findEnforcementClaims(files) {
  const claims = [];
  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const isClaim = ENFORCEMENT_PATTERNS.some((re) => re.test(line));
        if (isClaim && !DEFERRAL_MARKER.test(line)) {
          claims.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  return claims;
}

export function findOwnershipDrift(codeownersEntries, docFiles) {
  const ownerMap = new Map();
  for (const { pattern, owners } of codeownersEntries) {
    ownerMap.set(normalizePattern(pattern), new Set(owners));
  }
  const problems = [];
  for (const file of docFiles) {
    if (!existsSync(file)) {
      continue;
    }
    const content = readFileSync(file, "utf8");
    if (
      CODEOWNERS_MENTION.test(content) &&
      !content.includes(".github/CODEOWNERS")
    ) {
      problems.push(
        `${file}: references CODEOWNERS but not the .github/CODEOWNERS path`
      );
    }
    content.split("\n").forEach((raw, index) => {
      const line = raw.trim().replace(LIST_BULLET, "").replace(BACKTICK, "");
      const tokens = line.split(WHITESPACE);
      if (tokens.length < 2) {
        return;
      }
      const key = normalizePattern(tokens[0]);
      const owners = tokens.slice(1).filter((token) => token.startsWith("@"));
      if (owners.length === 0 || !ownerMap.has(key)) {
        return;
      }
      const expected = ownerMap.get(key);
      const diverges =
        owners.some((owner) => !expected.has(owner)) ||
        [...expected].some((owner) => !owners.includes(owner));
      if (diverges) {
        problems.push(
          `${file}:${index + 1}: restated owners for "${tokens[0]}" disagree with .github/CODEOWNERS`
        );
      }
    });
  }
  return problems;
}
