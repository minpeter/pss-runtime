import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRIBUTING_PATH = "CONTRIBUTING.md";

// The evidence mandate that section (a) must carry.
const EVIDENCE_MANDATE = /\.omo\/evidence\//;

// A level-1+ ATX heading line, captured for section-anchor matching.
const HEADING_LINE = /^#{1,6}\s+(.*)$/;

// Heading-text anchors for each required section (wording may vary).
const QA_HEADING = /qa|quality|evidence/;
const COMMIT_PR_HEADING = /commit|pull request|pull-request|\bpr\b/;
const NEVER_HEADING = /never/;
const CLEANUP_HEADING = /clean\s*-?up|tear\s*-?down/;

// Required contribution sections, located by heading text so wording may vary.
// Each `test` fails when its section is absent, which is how a removed section
// (e.g. the "Never" list) is detected.
export const REQUIRED_SECTIONS = [
  {
    id: "qa-evidence",
    label: "QA/evidence discipline",
    // Real-surface QA plus the mandate that evidence lives under .omo/evidence/.
    test: (text) => hasHeading(text, QA_HEADING) && EVIDENCE_MANDATE.test(text),
  },
  {
    id: "commit-pr",
    label: "commit and PR rules",
    test: (text) => hasHeading(text, COMMIT_PR_HEADING),
  },
  {
    id: "never",
    label: 'the "Never" list',
    test: (text) => hasHeading(text, NEVER_HEADING),
  },
  {
    id: "cleanup",
    label: "cleanup of spawned processes/ports/temp dirs",
    test: (text) => hasHeading(text, CLEANUP_HEADING),
  },
];

export function readContributing(root = ".") {
  return readFileSync(join(root, CONTRIBUTING_PATH), "utf8");
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

export function hasHeading(text, regex) {
  return headingAnchors(text).some((anchor) => regex.test(anchor));
}

export function missingSections(text) {
  return REQUIRED_SECTIONS.filter((section) => !section.test(text)).map(
    (section) => section.label
  );
}

// Runtime-artifact roots that are gitignored and therefore validated for
// reference syntax only, never filesystem existence. `.omo/plans/` is not
// itself gitignored but is still under `.omo/**`, so the whole prefix is
// exempt per the contract.
const EXEMPT_PREFIX = /^\.(?:omo|senpi)(?:\/|$)/;

// Tokens that are not concrete repo-relative paths: globs and doc placeholders.
const GLOB_OR_PLACEHOLDER = /[*<>\s]/;

const CODE_SPAN = /`([^`]+)`/g;
const MARKDOWN_LINK = /\]\(([^)]+)\)/g;
const LEADING_DOT_SLASH = /^\.\//;
const TRAILING_SLASH = /\/+$/;
const WHITESPACE = /\s+/;
const ANCHOR = /#/;

export function normalizeToken(token) {
  return token
    .split(ANCHOR)[0]
    .trim()
    .replace(LEADING_DOT_SLASH, "")
    .replace(TRAILING_SLASH, "");
}

// Path citations are pulled from code spans (split on whitespace so a path
// embedded in a command is caught) and markdown link targets. A token counts
// as a cited path when it is either exempt (`.omo/**`/`.senpi/**`) or a
// concrete repo-relative path (has a separator, no glob/placeholder).
export function extractCitedPaths(text) {
  const tokens = new Set();
  for (const span of text.matchAll(CODE_SPAN)) {
    for (const word of span[1].split(WHITESPACE)) {
      tokens.add(word);
    }
  }
  for (const link of text.matchAll(MARKDOWN_LINK)) {
    tokens.add(link[1]);
  }
  const paths = [];
  for (const token of tokens) {
    const norm = normalizeToken(token);
    if (norm === "") {
      continue;
    }
    if (EXEMPT_PREFIX.test(norm)) {
      paths.push(norm);
      continue;
    }
    if (!norm.includes("/") || GLOB_OR_PLACEHOLDER.test(norm)) {
      continue;
    }
    paths.push(norm);
  }
  return paths;
}

export function isExempt(path) {
  return EXEMPT_PREFIX.test(path);
}

// A cited path is well-formed when it is repo-relative: never absolute and
// never escaping the repository root with a `..` segment.
export function hasInvalidSyntax(path) {
  if (path.startsWith("/")) {
    return true;
  }
  return path.split("/").includes("..");
}

export function invalidSyntaxPaths(text) {
  return extractCitedPaths(text).filter(hasInvalidSyntax);
}

// Batch classification of non-exempt paths that git ignores. Gitignored
// runtime artifacts (e.g. `coverage/`) are exempt from existence resolution
// exactly like `.omo/**` and `.senpi/**`.
export function gitIgnoredPaths(paths, root = ".") {
  if (paths.length === 0) {
    return new Set();
  }
  const result = spawnSync("git", ["check-ignore", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  const ignored = new Set();
  // exit 0 => at least one ignored (printed); 1 => none ignored; both are fine.
  if (result.status === 0 || result.status === 1) {
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed !== "") {
        ignored.add(trimmed);
      }
    }
  }
  return ignored;
}

// Non-exempt, non-gitignored cited paths that do not resolve on disk. A stale
// reference to a tracked path lands here; an absent gitignored artifact path
// does not.
export function unresolvedCitedPaths(text, root = ".") {
  const nonExempt = extractCitedPaths(text).filter((path) => !isExempt(path));
  const ignored = gitIgnoredPaths(nonExempt, root);
  return nonExempt.filter(
    (path) => !(ignored.has(path) || existsSync(join(root, path)))
  );
}
