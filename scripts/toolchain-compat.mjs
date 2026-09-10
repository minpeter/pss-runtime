// Toolchain compatibility invariants (VAL-SEC-044): every analysis/security
// tool the mission added as a root devDependency must declare an
// engines.node range satisfied by the ci.yml Node 24/26 matrix; the
// installed TypeScript toolchain stays on TypeScript 7; and TypeDoc remains
// excluded — no devDependency, no script, no lockfile entry — with the
// exclusion and its rationale stated in repository docs.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Root devDependencies added by this mission's tooling features (pre-commit
// hook, Knip, jscpd, the YAML parser). Keep sorted; diagnostics must never
// depend on object iteration order.
export const NEW_TOOL_DEV_DEPENDENCIES = [
  "husky",
  "jscpd",
  "knip",
  "lint-staged",
  "yaml",
];

// Tool binaries executed directly by the new gates (evidence that the
// devDependency is executable on the current Node).
export const TOOL_BINARIES = ["jscpd", "knip"];

// Representative versions of the ci.yml matrix legs.
export const NODE_MATRIX_PROBES = ["24.0.0", "26.0.0"];

// Docs scanned for the TypeDoc-exclusion statement: every markdown file
// under docs/ plus the root agent/contributor docs.
const DOC_ROOTS = ["AGENTS.md", "CONTRIBUTING.md", "README.md", "SECURITY.md"];
const DOCS_DIR = "docs";
const MARKDOWN_FILE = /\.md$/;

// --- minimal semver-range satisfaction -------------------------------------

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/;
const COMPARATOR_PATTERN =
  /^(<=|>=|<|>|=|\^|~)?v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?$/;
const OPERATOR_GAP = /(<=|>=|<|>|=|\^|~)\s+/g;
const WHITESPACE = /\s+/;

export function parseVersion(version) {
  const match = String(version).trim().match(VERSION_PATTERN);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

// Expand one comparator token into a [lower, upper] bound pair where each
// bound is {version, inclusive} or null when unbounded. Partial versions
// follow the semver spec: "18" means >=18.0.0 <19.0.0, "18.2" means
// >=18.2.0 <18.3.0.
function comparatorBounds(token) {
  const match = token.match(COMPARATOR_PATTERN);
  if (!match) {
    return null;
  }
  const [, operator = "", majorRaw, minorRaw, patchRaw] = match;
  if (majorRaw === "x" || majorRaw === "*") {
    return { lower: null, upper: null };
  }
  const major = Number(majorRaw);
  if (minorRaw === undefined || minorRaw === "x" || minorRaw === "*") {
    const lower = { version: [major, 0, 0], inclusive: true };
    const upper = { version: [major + 1, 0, 0], inclusive: false };
    return oriented(operator, lower, upper, [major, 0, 0]);
  }
  const minor = Number(minorRaw);
  if (patchRaw === undefined || patchRaw === "x" || patchRaw === "*") {
    const lower = { version: [major, minor, 0], inclusive: true };
    const upper = { version: [major, minor + 1, 0], inclusive: false };
    return oriented(operator, lower, upper, [major, minor, 0]);
  }
  const version = [major, minor, Number(patchRaw)];
  if (operator === "^") {
    let upper = [0, 0, Number(patchRaw) + 1];
    if (major > 0) {
      upper = [major + 1, 0, 0];
    } else if (minor > 0) {
      upper = [0, minor + 1, 0];
    }
    return {
      lower: { version, inclusive: true },
      upper: { version: upper, inclusive: false },
    };
  }
  if (operator === "~") {
    return {
      lower: { version, inclusive: true },
      upper: { version: [major, minor + 1, 0], inclusive: false },
    };
  }
  return oriented(
    operator,
    { version, inclusive: true },
    { version, inclusive: true },
    version
  );
}

// Map an explicit operator onto the partial/caret bounds computed above.
function oriented(operator, lower, upper, exact) {
  switch (operator) {
    case ">":
      return { lower: { version: exact, inclusive: false }, upper: null };
    case ">=":
      return { lower: { version: exact, inclusive: true }, upper: null };
    case "<":
      return { lower: null, upper: { version: exact, inclusive: false } };
    case "<=":
      return { lower: null, upper: { version: exact, inclusive: true } };
    default:
      return { lower, upper };
  }
}

function withinBounds(version, { lower, upper }) {
  if (lower) {
    const order = compareVersions(version, lower.version);
    if (order < 0 || (order === 0 && !lower.inclusive)) {
      return false;
    }
  }
  if (upper) {
    const order = compareVersions(version, upper.version);
    if (order > 0 || (order === 0 && !upper.inclusive)) {
      return false;
    }
  }
  return true;
}

// True when `version` satisfies an npm semver range composed of ||-separated
// comparator sets. Returns false for unparseable ranges: an engines range we
// cannot evaluate is never waved through.
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return false;
  }
  const sets = String(range)
    .replace(OPERATOR_GAP, "$1")
    .split("||")
    .map((set) => set.trim())
    .filter((set) => set !== "");
  if (sets.length === 0) {
    return false;
  }
  return sets.some((set) =>
    set
      .split(WHITESPACE)
      .filter((token) => token !== "")
      .every((token) => {
        const bounds = comparatorBounds(token);
        return bounds !== null && withinBounds(parsed, bounds);
      })
  );
}

// --- engines.node against the Node 24/26 matrix -----------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function enginesProblems(probes = NODE_MATRIX_PROBES) {
  const problems = [];
  for (const name of NEW_TOOL_DEV_DEPENDENCIES) {
    const pkg = readJson(join("node_modules", name, "package.json"));
    if (!pkg) {
      problems.push(
        `${name}: not resolvable under node_modules (run pnpm install --frozen-lockfile)`
      );
      continue;
    }
    const range = pkg?.engines?.node;
    if (range === undefined) {
      continue;
    }
    for (const probe of probes) {
      if (!satisfiesRange(probe, range)) {
        problems.push(
          `${name}@${pkg.version} engines.node "${range}" is not satisfied by Node ${probe}`
        );
      }
    }
  }
  return problems;
}

// --- TypeDoc exclusion ------------------------------------------------------

const TYPEDOC_TOKEN = /typedoc/i;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// The documented exclusion statement must name TypeDoc, state that the
// installed TypeScript 7 toolchain is outside its supported range, and keep
// the public API snapshot as the runtime API contract.
const TYPEDOC_STATEMENT_PATTERNS = [
  /TypeDoc/,
  /TypeScript 7/,
  /outside[^.\n]*supported range/i,
  /public API snapshot/i,
  /API contract/i,
];

function docFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((entry) => MARKDOWN_FILE.test(entry))
    .sort()
    .map((entry) => join(dir, entry));
}

export function docTexts() {
  const texts = [];
  for (const path of DOC_ROOTS) {
    if (existsSync(path)) {
      texts.push(readFileSync(path, "utf8"));
    }
  }
  for (const path of docFiles(DOCS_DIR)) {
    texts.push(readFileSync(path, "utf8"));
  }
  return texts;
}

export function typedocProblems(rootPackageJson, lockfileText, texts) {
  const problems = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(rootPackageJson?.[field] ?? {})) {
      if (TYPEDOC_TOKEN.test(name)) {
        problems.push(`root ${field} contains ${name}`);
      }
    }
  }
  for (const [name, command] of Object.entries(
    rootPackageJson?.scripts ?? {}
  )) {
    if (TYPEDOC_TOKEN.test(String(command))) {
      problems.push(`root script "${name}" references typedoc`);
    }
  }
  if (TYPEDOC_TOKEN.test(lockfileText)) {
    problems.push("pnpm-lock.yaml references typedoc");
  }
  const documented = texts.some((text) =>
    TYPEDOC_STATEMENT_PATTERNS.every((pattern) => pattern.test(text))
  );
  if (!documented) {
    problems.push(
      "no repository doc states the TypeDoc exclusion (the installed TypeScript 7 toolchain is outside TypeDoc's supported range; the public API snapshot remains the runtime API contract)"
    );
  }
  return problems;
}
