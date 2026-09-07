// Committed gitleaks config allowlist invariants (VAL-SEC-031), imported by
// scripts/security-gitleaks.mjs (workflow scope checks) and
// scripts/security-gitleaks.test.mjs. Static TOML-lite scan of the committed
// config: no network, no ports, no writes, no clock. Split from
// security-gitleaks.mjs to stay under the 250 pure-LOC ceiling.

export const GITLEAKS_CONFIG_PATH = ".gitleaks.toml";

const ALLOWLIST_HEADER = /^\[allowlist\]\s*$/m;
const NEXT_SECTION = /^\[/m;
const TRIPLE_QUOTED = /'''([\s\S]*?)'''/g;
const ARRAY_FOR = (key) => new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`);
const CATCH_ALL = /^\^?\s*\.\s*[*+]\s*\$?$/;
const SPECIFIC_LITERAL = /[A-Za-z]{4,}/;
const EXTENDS_DEFAULT = /\[extend\][\s\S]*?useDefault\s*=\s*true/;
const ALLOWLIST_BLOCKS = /^\[allowlist\]\s*$/gm;

// Body of the single [allowlist] block: from its header line to the next
// TOML section header (or end of file).
function allowlistBlock(source) {
  const start = source.search(ALLOWLIST_HEADER);
  if (start === -1) {
    return null;
  }
  const rest = source.slice(start);
  const next = rest.slice(1).search(NEXT_SECTION);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function arrayEntries(block, key) {
  const match = block.match(ARRAY_FOR(key));
  if (!match) {
    return null;
  }
  return [...match[1].matchAll(TRIPLE_QUOTED)].map((m) => m[1]);
}

// Every allowlist path is anchored and names a concrete file; the example
// env placeholder files must be covered explicitly.
function pathProblems(paths) {
  const problems = [];
  for (const path of paths) {
    if (CATCH_ALL.test(path)) {
      problems.push(`allowlist path "${path}" is a catch-all suppression`);
      continue;
    }
    if (!(path.startsWith("^") && path.endsWith("$"))) {
      problems.push(`allowlist path "${path}" is not anchored with ^ and $`);
    }
    if (path.includes("*")) {
      problems.push(
        `allowlist path "${path}" uses a glob; name a concrete file`
      );
    }
    // Anchors were checked above; strip them positionally, not by regex.
    const tail = path.slice(1, -1).split("/").pop();
    if (!tail.includes("\\.")) {
      problems.push(
        `allowlist path "${path}" does not name a concrete file (final segment lacks a literal dot)`
      );
    }
  }
  const normalized = paths.map((path) => path.replace(/\\/g, ""));
  if (!normalized.some((path) => path.includes(".dev.vars.example"))) {
    problems.push(
      "allowlist has no path covering the .dev.vars.example placeholders"
    );
  }
  if (!normalized.some((path) => path.includes(".env.example"))) {
    problems.push("allowlist has no path covering .env.example placeholders");
  }
  return problems;
}

function regexProblems(regexes) {
  return regexes.flatMap((regex) => {
    if (CATCH_ALL.test(regex)) {
      return [`allowlist regex "${regex}" is a catch-all suppression`];
    }
    if (!SPECIFIC_LITERAL.test(regex)) {
      return [
        `allowlist regex "${regex}" carries no specific literal; broad suppressions are not allowed`,
      ];
    }
    return [];
  });
}

// The committed gitleaks config: extends the default rule set (dropping it
// would suppress the whole rule base), declares exactly one allowlist, and
// every allowlist entry is an anchored concrete path or a narrow regex.
export function gitleaksConfigProblems(source) {
  const problems = [];
  if (!EXTENDS_DEFAULT.test(source)) {
    problems.push(
      `${GITLEAKS_CONFIG_PATH} does not extend the default gitleaks rules (useDefault = true)`
    );
  }
  const blocks = source.match(ALLOWLIST_BLOCKS) ?? [];
  if (blocks.length !== 1) {
    problems.push(
      `${GITLEAKS_CONFIG_PATH} must declare exactly one [allowlist] block, found ${blocks.length}`
    );
    return problems;
  }
  const block = allowlistBlock(source) ?? "";
  const paths = arrayEntries(block, "paths");
  if (!paths || paths.length === 0) {
    problems.push(
      `${GITLEAKS_CONFIG_PATH} allowlist declares no paths; known false positives must be listed explicitly`
    );
  } else {
    problems.push(...pathProblems(paths));
  }
  const regexes = arrayEntries(block, "regexes");
  if (regexes) {
    problems.push(...regexProblems(regexes));
  }
  return problems;
}
