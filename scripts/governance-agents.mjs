import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_FILE = "AGENTS.md";
export const MIN_SUBSTANTIVE_LINES = 3;
export const FORBIDDEN_STRINGS = [
  "new Agent({",
  "agent.session(",
  "~/.pss/sessions",
  "NPM_TOKEN",
];
export const GOVERNANCE_DOCS = ["SECURITY.md", "CONTRIBUTING.md", "README.md"];
export const RUNBOOKS_DIR = "docs/runbooks";
export const ENV_SEARCH_DIRS = [
  "packages",
  "apps",
  "extensions",
  "examples",
  "experimental",
  "docs",
  "scripts",
];

const CODE_SPAN = /`([^`]+)`/g;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const PATH_TOKEN = /^\.{0,2}\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/;
const DATE_PLACEHOLDER = /YYYY/;
const TREE_LINE = /^\s*(?:│\s*)?(?:├──|└──)\s*(\S+)/;
const BRACE_GROUP = /\{([^{}]+)\}/;
const STRUCTURE_HEADING = /^##\s+STRUCTURE\s*$/;
const FENCE_LINE = /^```/;
const FILE_EXT = /\.[a-z0-9]+$/i;
const TRAILING_SLASH = /\/$/;
const LEADING_DOT_SLASH = /^\.\//;
const HEADING_MARKER = /^#+\s*/;
const LIST_MARKER = /^[-*+]\s+/;
const COMMENT_LINE = /^(?:<!--|\/\/)/;
const PLACEHOLDER_LINE = /^(?:TBD|TODO|FIXME|PLACEHOLDER|STUB)[\s:.-]*$/i;
const ENV_KNOB = /\bPSS_[A-Z0-9_]+\*?\b/g;
const TRAILING_GLOB = /\*$/;
const AGENTS_BASENAME = /(^|\/)AGENTS\.md$/;
const INDENTED_CONTINUATION = /\n(?=[ \t]+\S)/g;
const FENCED_BLOCK = /^```[\s\S]*?^```/gm;

// Text with fenced code blocks removed, so their backticks cannot misalign
// inline code-span matching.
function proseOnly(text) {
  return text.replace(FENCED_BLOCK, "");
}

// Run a read-only git command and return its stdout lines; empty on failure so
// callers fail their own named assertion instead of throwing here.
export function gitLines(args, root = ".") {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (res.status !== 0 || res.error) {
    return [];
  }
  return res.stdout.split("\n").filter((line) => line.length > 0);
}

// AGENTS.md files as git tracks them. `.gitignore` lists AGENTS.md and
// `**/AGENTS.md`, so tracked state (not filesystem presence) is the source of
// truth: an untracked shadow copy must not silently satisfy or skip a check.
export function trackedAgentsFiles(root = ".") {
  const tracked = gitLines(
    ["ls-files", "--", AGENTS_FILE, ":(glob)**/AGENTS.md"],
    root
  );
  return [...new Set(tracked)].sort();
}

export function isTracked(path, root = ".") {
  return gitLines(["ls-files", "--", path], root).includes(path);
}

export function readAgents(root = ".") {
  return readFileSync(join(root, AGENTS_FILE), "utf8");
}

function expandBraces(token) {
  const match = BRACE_GROUP.exec(token);
  if (!match) {
    return [token];
  }
  return match[1]
    .split(",")
    .map((alt) => token.replace(BRACE_GROUP, alt.trim()));
}

// Directory paths named in the STRUCTURE section's tree fence (VAL-GOV-040).
export function structurePaths(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => STRUCTURE_HEADING.test(line));
  if (start === -1) {
    return [];
  }
  const paths = [];
  let inFence = false;
  for (const line of lines.slice(start + 1)) {
    if (FENCE_LINE.test(line)) {
      if (inFence) {
        break;
      }
      inFence = true;
      continue;
    }
    if (!inFence) {
      continue;
    }
    const match = TREE_LINE.exec(line);
    if (match) {
      paths.push(...expandBraces(match[1]));
    }
  }
  return paths;
}

export function missingPaths(paths, root = ".") {
  return paths.filter(
    (path) => !existsSync(join(root, path.replace(TRAILING_SLASH, "")))
  );
}

function spanTokens(line) {
  return [...line.matchAll(CODE_SPAN)].map((match) => match[1].trim());
}

// Child-guidance references: backticked paths on a logical line that mentions
// AGENTS.md. A token ending in AGENTS.md resolves directly; a directory token
// resolves to `<dir>/AGENTS.md`. Markdown hard-wraps are joined first so a
// wrapped bullet keeps its full token list; table rows stay one-per-line
// because they start at column zero (VAL-GOV-041).
export function childGuidanceRefs(text) {
  const refs = new Set();
  const logical = proseOnly(text).replace(INDENTED_CONTINUATION, " ");
  for (const line of logical.split("\n")) {
    if (!line.includes(AGENTS_FILE)) {
      continue;
    }
    for (const token of spanTokens(line)) {
      if (!PATH_TOKEN.test(token) || token.includes("*")) {
        continue;
      }
      const clean = token
        .replace(LEADING_DOT_SLASH, "")
        .replace(TRAILING_SLASH, "");
      if (clean === AGENTS_FILE || clean.endsWith(`/${AGENTS_FILE}`)) {
        refs.add(clean);
      } else if (!FILE_EXT.test(clean)) {
        refs.add(`${clean}/${AGENTS_FILE}`);
      }
    }
  }
  return [...refs].sort();
}

// Stub definition from VAL-GOV-041: a target is a stub when it is zero bytes,
// whitespace-only, or has fewer than MIN_SUBSTANTIVE_LINES substantive lines,
// where substantive means a non-comment, non-whitespace line that is not only
// a placeholder marker (TBD/TODO/FIXME/placeholder/stub).
export function stubViolations(content) {
  if (content.length === 0) {
    return ["target is zero bytes"];
  }
  if (content.trim().length === 0) {
    return ["target is whitespace-only"];
  }
  const substantive = content.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (
      trimmed === "" ||
      COMMENT_LINE.test(trimmed) ||
      FENCE_LINE.test(trimmed)
    ) {
      return false;
    }
    const text = trimmed
      .replace(HEADING_MARKER, "")
      .replace(LIST_MARKER, "")
      .trim();
    if (text === "") {
      return false;
    }
    return !PLACEHOLDER_LINE.test(text);
  });
  if (substantive.length < MIN_SUBSTANTIVE_LINES) {
    return [
      `target has ${substantive.length} substantive lines (< ${MIN_SUBSTANTIVE_LINES})`,
    ];
  }
  return [];
}

// Repo-root-relative paths AGENTS.md cites in code spans or links. A token
// only counts as a citation when its first segment is a real top-level entry:
// shorthand like `bin/pss.js` or `index.ts` is contextual, not a citation
// (VAL-GOV-042).
export function citedPaths(text, root = ".") {
  const anchors = new Set(readdirSync(root));
  const prose = proseOnly(text);
  const tokens = [];
  for (const match of prose.matchAll(CODE_SPAN)) {
    tokens.push(match[1]);
  }
  for (const match of prose.matchAll(MARKDOWN_LINK)) {
    tokens.push(match[1].split("#")[0]);
  }
  const found = new Set();
  for (const raw of tokens) {
    const token = raw.trim();
    if (
      token === "" ||
      token.includes("*") ||
      token.includes("://") ||
      token.startsWith("/") ||
      DATE_PLACEHOLDER.test(token) ||
      !PATH_TOKEN.test(token)
    ) {
      continue;
    }
    const clean = token
      .replace(LEADING_DOT_SLASH, "")
      .replace(TRAILING_SLASH, "");
    if (anchors.has(clean.split("/")[0])) {
      found.add(clean);
    }
  }
  return [...found].sort();
}

// `PSS_*` env knobs documented in AGENTS.md; a trailing `*` wildcard means the
// prefix itself is the identifier to trace (VAL-GOV-044).
export function envKnobs(text) {
  const knobs = [...text.matchAll(ENV_KNOB)].map((match) =>
    match[0].replace(TRAILING_GLOB, "")
  );
  return [...new Set(knobs)].sort();
}

// Non-AGENTS.md repository files that mention the knob. Documentation files
// never count as their own trace, and the generated nextjs-bench results tree
// is excluded from the scan.
export function knobTraceFiles(knob, root = ".") {
  return gitLines(
    [
      "grep",
      "-l",
      "-F",
      knob,
      "--",
      ...ENV_SEARCH_DIRS,
      ":(exclude)experimental/nextjs-bench/results/**",
    ],
    root
  ).filter((file) => !AGENTS_BASENAME.test(file));
}

export function untracedKnobs(text, root = ".") {
  return envKnobs(text).filter(
    (knob) => knobTraceFiles(knob, root).length === 0
  );
}

// Forbidden anti-pattern strings, reported as `line: match` (VAL-GOV-043).
export function forbiddenHits(text) {
  const hits = [];
  text.split("\n").forEach((line, index) => {
    for (const bad of FORBIDDEN_STRINGS) {
      if (line.includes(bad)) {
        hits.push(`${index + 1}: ${bad}`);
      }
    }
  });
  return hits;
}

// Agent-context surfaces the forbidden-string scan covers: every tracked
// AGENTS.md, the root governance docs, and the tracked runbooks.
export function governanceScanFiles(root = ".") {
  const files = [
    ...trackedAgentsFiles(root),
    ...GOVERNANCE_DOCS,
    ...gitLines(["ls-files", "--", `${RUNBOOKS_DIR}/*.md`], root),
  ];
  return [...new Set(files)].filter((file) => existsSync(join(root, file)));
}
