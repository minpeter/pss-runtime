import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_PATTERNS } from "./governance-invariants.mjs";

// Full tracked-tree credential scan (VAL-CROSS-015): every git-tracked file
// is checked for credential-shaped literals (the shared CREDENTIAL_PATTERNS
// from the governance scan), and the only tolerated hits are the pinned
// allowlist below — scanner definitions and name-only negative fixtures that
// reference token NAMES. The allowlist is exact on both sides:
// a hit outside it fails, and an entry that stops being tracked or stops
// producing its pinned kind also fails, so the list cannot rot silently.
// Git access is a read-only `git ls-files` query; nothing here writes, binds
// a port, or touches the network. Invariants live in secret-scan.test.mjs.

// path -> sorted list of CREDENTIAL_PATTERNS kinds that file may produce.
// Each entry is a scanner definition or a deliberate negative fixture.
export const SCAN_ALLOWLIST = {
  // Negative fixture intentionally exercises unsafe npm-token assignment detection.
  "scripts/governance-pr-template.test.mjs": ["npm access token reference"],
};

const NUL_CHAR = "\0";

// Read-only tracked-file list (git ls-files at the repository root).
export function trackedFiles() {
  const res = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.stderr}`);
  }
  return res.stdout.split(NUL_CHAR).filter(Boolean);
}

// [{ line, kind }] for one text; binary content (NUL byte) yields no hits.
export function textCredentialHits(text) {
  if (text.includes(NUL_CHAR)) {
    return [];
  }
  const hits = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const [kind, pattern] of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({ line: index + 1, kind });
      }
    }
  }
  return hits;
}

const defaultReader = (path) => readFileSync(join(".", path), "utf8");

// [{ path, line, kind }] across the given tracked files.
export function treeCredentialHits(files, reader = defaultReader) {
  return files.flatMap((path) =>
    textCredentialHits(reader(path)).map((hit) => ({ path, ...hit }))
  );
}

function isAllowed(hit, allowlist) {
  return (allowlist[hit.path] ?? []).includes(hit.kind);
}

// Human-readable problems for hits outside the pinned allowlist.
export function unexpectedHitProblems(hits, allowlist = SCAN_ALLOWLIST) {
  return hits
    .filter((hit) => !isAllowed(hit, allowlist))
    .map(
      (hit) =>
        `${hit.path}: line ${hit.line}: ${hit.kind} (not in the pinned scan allowlist)`
    );
}

// Allowlist anti-rot: every entry must still be tracked and must still
// produce at least one hit of each pinned kind, so cleanup of a scanner or
// fixture forces a deliberate allowlist edit instead of silent drift.
export function allowlistHygieneProblems(
  hits,
  allowlist = SCAN_ALLOWLIST,
  files = trackedFiles()
) {
  const tracked = new Set(files);
  const problems = [];
  for (const [path, kinds] of Object.entries(allowlist)) {
    if (!tracked.has(path)) {
      problems.push(`scan allowlist entry not git-tracked: ${path}`);
      continue;
    }
    for (const kind of kinds) {
      const exercised = hits.some(
        (hit) => hit.path === path && hit.kind === kind
      );
      if (!exercised) {
        problems.push(
          `scan allowlist entry no longer produces "${kind}": ${path} (remove or re-pin the entry)`
        );
      }
    }
  }
  return problems;
}
