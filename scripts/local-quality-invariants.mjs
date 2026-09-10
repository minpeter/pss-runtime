import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// Meta-invariants for the deterministic local-quality config checks
// (VAL-LOCAL-021 .. VAL-LOCAL-026). Everything here is a static decision over
// committed repository files: no network, no ports, no writes, no clock.

// The six config checks and the exact source files that implement them.
// The registry order is fixed, so diagnostics never depend on filesystem
// iteration order.
const DEVCONTAINER_FILES = [
  "scripts/devcontainer.mjs",
  "scripts/devcontainer.test.mjs",
  "scripts/jsonc.mjs",
];
const DEPENDABOT_FILES = [
  "scripts/dependabot-config.mjs",
  "scripts/dependabot-config.test.mjs",
];
const NAMING_FILES = [
  "scripts/naming-conventions.mjs",
  "scripts/naming-conventions.test.mjs",
  "scripts/jsonc.mjs",
];
const RELEASE_AGE_FILES = [
  "scripts/release-age-policy.mjs",
  "scripts/release-age-policy.test.mjs",
];
const HOOK_FILES = [
  "scripts/precommit-hook.mjs",
  "scripts/precommit-hook.test.mjs",
  "scripts/precommit-policy.mjs",
];

export const CHECK_AREAS = [
  { id: "workspace-metadata", files: ["scripts/workspace-config.test.mjs"] },
  { id: "devcontainer-metadata", files: DEVCONTAINER_FILES },
  { id: "dependabot-shape", files: DEPENDABOT_FILES },
  { id: "naming-doc-coherence", files: NAMING_FILES },
  { id: "release-age-policy", files: RELEASE_AGE_FILES },
  { id: "hook-wiring", files: HOOK_FILES },
];

export const TIMING_WRAPPER_PATH = "scripts/time-gate.mjs";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const CONTRIBUTING_PATH = "CONTRIBUTING.md";
export const HOOK_PATH = ".husky/pre-commit";
export const LINT_STAGED_CONFIG_PATH = ".lintstagedrc.json";

export function checkFiles() {
  return [...new Set(CHECK_AREAS.flatMap((area) => area.files))].sort();
}

export function readRepoFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// --- purity (VAL-LOCAL-021) ------------------------------------------------

// Constructs a deterministic, offline, side-effect-free check must never
// contain. `exec`-family patterns use a lookbehind so `regexp.exec(text)`
// does not false-positive.
const FORBIDDEN_SOURCE_PATTERNS = [
  [/\bnode:(?:http|https|http2|net|dgram|dns)\b/, "imports a network module"],
  [/(?<![\w$.])fetch\s*\(/, "calls fetch"],
  [/\bWebSocket\b|\bXMLHttpRequest\b/, "uses a network client"],
  [/\.listen\s*\(/, "binds a listening socket"],
  [/\.connect\s*\(/, "opens a socket connection"],
  [/\bwriteFileSync\s*\(|\bappendFileSync\s*\(/, "writes a file"],
  [/\bcreateWriteStream\s*\(/, "opens a write stream"],
  [
    /\bmkdirSync\s*\(|\brmSync\s*\(|\bunlinkSync\s*\(/,
    "mutates the filesystem",
  ],
  [/\brenameSync\s*\(/, "mutates the filesystem"],
  [/\bMath\.random\s*\(/, "uses Math.random"],
  [/\bDate\.now\s*\(|\bnew Date\s*\(/, "reads wall-clock time"],
  [/\bperformance\.now\s*\(/, "reads wall-clock time"],
  [/(?<![\w$.])spawn\s*\(/, "spawns an async child process"],
  [/(?<![\w$.])exec\s*\(/, "spawns a shell child process"],
  [/(?<![\w$.])execFile\s*\(/, "spawns an async child process"],
  [/(?<![\w$.])fork\s*\(/, "spawns a child process"],
  [/\bsetTimeout\s*\(|\bsetInterval\s*\(/, "uses a timer"],
];

export function purityProblems(label, source) {
  return FORBIDDEN_SOURCE_PATTERNS.filter(([pattern]) =>
    pattern.test(source)
  ).map(([, reason]) => `${label} ${reason}`);
}

function countMatches(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

// Enumeration order must never leak into diagnostics: readdirSync output is
// filesystem order, so any file using it must sort the listing. Synchronous
// subprocesses are allowed only for read-only git queries (spawnSync("git")),
// which are short-lived and leave no survivors.
const READDIR_CALL = /\breaddirSync\s*\(/g;
const SORT_CALL = /\.sort\s*\(/;
const SPAWN_SYNC_CALL = /\bspawnSync\s*\(/g;
const GIT_SPAWN_SYNC_CALL = /\bspawnSync\s*\(\s*"git"/g;

export function orderingProblems(label, source) {
  const problems = [];
  if (countMatches(source, READDIR_CALL) > 0 && !SORT_CALL.test(source)) {
    problems.push(`${label} iterates a directory without sorting`);
  }
  const spawns = countMatches(source, SPAWN_SYNC_CALL);
  const gitSpawns = countMatches(source, GIT_SPAWN_SYNC_CALL);
  if (spawns !== gitSpawns) {
    problems.push(`${label} runs a non-git subprocess`);
  }
  return problems;
}

// --- fast-gate scope (VAL-LOCAL-024) ---------------------------------------

// A fast gate (pre-commit hook, lint-staged commands) never runs the full
// test suite, typecheck, build, coverage, API snapshot, stress profiles, or
// the TUI/Worker surfaces.
const HEAVY_GATE_PATTERNS = [
  [/(^|\s)pnpm\s+(run\s+)?test\b/, "runs the full test suite"],
  [/(^|\s)pnpm\s+(run\s+)?typecheck\b/, "runs the typecheck gate"],
  [/(^|\s)pnpm\s+(run\s+)?build\b/, "runs the build gate"],
  [/\bturbo\b/, "invokes turbo"],
  [/\bvitest\b/, "runs vitest"],
  [/(?<![\w$.])tsc\b/, "runs the typechecker"],
  [/\bcoverage\b/, "runs coverage"],
  [/\bstress/, "runs a stress profile"],
  [/api:check|api:update/, "runs the API snapshot"],
  [/dev:tui|dev:worker|dev:relay/, "starts a dev surface"],
  [/wrangler/, "starts the Worker toolchain"],
];

export function heavyGateProblems(label, command) {
  return HEAVY_GATE_PATTERNS.filter(([pattern]) => pattern.test(command)).map(
    ([, reason]) => `${label} ${reason}: ${command.trim()}`
  );
}

export function lintStagedCommands(configSource) {
  let parsed;
  try {
    parsed = JSON.parse(configSource);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  return Object.values(parsed)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(String);
}

// --- documented bounds (VAL-LOCAL-024/026) ---------------------------------

// The "Fast local gates" section of CONTRIBUTING.md declares one table row
// per gate with a concrete `≤ N s` bound. The pre-commit row must be ≤ 60 s.
const FAST_GATE_HEADING = /^#{1,6}\s+.*fast local gates.*$/im;
const NEXT_HEADING = /^#{1,6}\s+/m;
const TABLE_ROW = /^\|(.+)\|\s*$/;
const BOUND_CELL = /≤\s*(\d+)\s*s\b/;
const PRE_COMMIT_ROW = /pre-commit/i;
const SEPARATOR_CELL = /^[\s-]+$/;
const ONE_DEVCONTAINER_BUILD = /one\s+devcontainer\s+build/i;
const TWO_LIGHTWEIGHT = /two\s+lightweight/i;
const TIMING_WRAPPER_MENTION = /time-gate\.mjs/;

export function fastGateSection(docText) {
  const heading = docText.match(FAST_GATE_HEADING);
  if (!heading) {
    return null;
  }
  const rest = docText.slice(heading.index + heading[0].length);
  const next = rest.search(NEXT_HEADING);
  return next === -1 ? rest : rest.slice(0, next);
}

export function gateRows(section) {
  return section
    .split("\n")
    .map((line) => line.match(TABLE_ROW))
    .filter(Boolean)
    .map((match) => match[1].split("|").map((cell) => cell.trim()))
    .filter(
      (cells) => cells.length >= 2 && cells[0] !== "" && cells[0] !== "---"
    )
    .filter((cells) => !(SEPARATOR_CELL.test(cells[0]) || cells[0] === "Gate"));
}

export function gateBoundProblems(docText) {
  const section = fastGateSection(docText);
  if (section === null) {
    return ['CONTRIBUTING.md has no "Fast local gates" section'];
  }
  const problems = [];
  const rows = gateRows(section);
  const preCommit = rows.find((cells) => PRE_COMMIT_ROW.test(cells[0]));
  if (preCommit) {
    const bound = preCommit.at(-1).match(BOUND_CELL);
    if (!bound) {
      problems.push("pre-commit gate has no concrete `≤ N s` bound");
    } else if (Number(bound[1]) > 60) {
      problems.push(`pre-commit bound ${bound[1]}s exceeds the 60s ceiling`);
    }
  } else {
    problems.push("no gate row covers the pre-commit hook");
  }
  const gatesWithBounds = rows.filter((cells) => BOUND_CELL.test(cells.at(-1)));
  for (const cells of rows) {
    if (!BOUND_CELL.test(cells.at(-1))) {
      problems.push(`gate "${cells[0]}" lacks a concrete numeric bound`);
    }
  }
  if (gatesWithBounds.length < 3) {
    problems.push(
      "fewer than three fast gates carry concrete bounds (pre-commit plus at least two others)"
    );
  }
  if (!ONE_DEVCONTAINER_BUILD.test(section)) {
    problems.push("section does not state the one-devcontainer-build budget");
  }
  if (!TWO_LIGHTWEIGHT.test(section)) {
    problems.push(
      "section does not state the two-lightweight-validators budget"
    );
  }
  if (!TIMING_WRAPPER_MENTION.test(section)) {
    problems.push("section does not document the timing wrapper");
  }
  return problems;
}

// --- CI wiring (VAL-LOCAL-023) ----------------------------------------------

const TEST_STEP_RUN = /(^|\s)pnpm\s+test(\s|$)/;

export function ciWiringProblems(workflowSource) {
  let doc;
  try {
    doc = parseYaml(workflowSource);
  } catch (error) {
    return [`ci workflow parse error: ${error.message}`];
  }
  const problems = [];
  const nodes = (doc?.jobs?.checks?.strategy?.matrix?.node ?? []).map(String);
  for (const version of ["24", "26"]) {
    if (!nodes.includes(version)) {
      problems.push(`ci matrix does not include Node ${version}`);
    }
  }
  const steps = doc?.jobs?.checks?.steps ?? [];
  const testStep = steps.find(
    (step) => typeof step?.run === "string" && TEST_STEP_RUN.test(step.run)
  );
  if (!testStep) {
    problems.push("no ci step runs `pnpm test`");
  } else if (
    String(testStep.env?.PSS_TASK_VALIDATOR_NETWORK_ISOLATED ?? "") !== "1"
  ) {
    problems.push(
      "the `pnpm test` step lacks PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1"
    );
  }
  return problems;
}

// --- timing wrapper contract (VAL-LOCAL-024) --------------------------------

// The wrapper measures a gate against its bound, kills the whole process
// group on timeout (negative pid), and reports a stable one-line result.
const WRAPPER_REQUIREMENTS = [
  [/"--bound"/, "accepts a --bound seconds argument"],
  [/"--label"/, "accepts a --label argument"],
  [/\bspawn\s*\(/, "spawns the gate command"],
  [/detached:\s*true/, "runs the gate in its own process group"],
  [/process\.kill\s*\(\s*-/, "kills the whole process group on timeout"],
  [/"SIGKILL"/, "uses SIGKILL so no child survives"],
  [/\belapsed\b/, "reports the measured elapsed time"],
  [/process\.exitCode/, "propagates a failing exit code"],
];

export function timingWrapperProblems(source) {
  return WRAPPER_REQUIREMENTS.filter(([pattern]) => !pattern.test(source)).map(
    ([, requirement]) => `scripts/time-gate.mjs ${requirement}`
  );
}
