// Local-vs-CI lint parity invariants (VAL-CROSS-003). The pre-commit path
// (husky -> lint-staged -> `ultracite fix` on the staged index set) and the CI
// lint gate (ci.yml -> `pnpm lint` -> `ultracite check .` on the full tree)
// must apply the SAME Biome/Ultracite rule set from the single root
// biome.jsonc, differing only in file scope: staged index set locally, full
// tree in CI. No full-suite or service-start command may be reachable from
// the pre-commit path. Static over committed files: no network, no ports.

import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { parseJsonc } from "./jsonc.mjs";
import {
  HOOK_PATH,
  locateConfig,
  parseConfig,
  readRepoFile,
} from "./precommit-hook.mjs";

export const BIOME_CONFIG = "biome.jsonc";
export const CI_WORKFLOW = ".github/workflows/ci.yml";

const LINT_STEP_NAME = /^\s*lint\s*$/i;
const PNPM_LINT_RUN = /^pnpm\s+(?:run\s+)?lint$/;
const ULTRACITE_RUN = /\bultracite\b/;
const ULTRACITE_SUBCOMMAND =
  /(?:^|\s)(?:pnpm\s+exec\s+)?ultracite\s+(fix|check)\b/;
const DIVERGENCE_FLAG = /--(?:config|only|skip|rules|use-editorconfig)/;
const FULL_TREE_ARG = /(?:^|\s)\.(?:\s|$)/;
const HOOK_EXECUTABLE = /^pnpm\s+exec\s+lint-staged$/;
const BIOME_FILE = /(^|\/)biome\.jsonc?$/;
const ULTRACITE_EXTENDS = /^ultracite/;

// Commands that must never be reachable from the commit hook: the full suite
// and any service start stay in CI or explicit local runs (VAL-CROSS-003).
const HEAVY_PATTERNS = [
  { label: "full pipeline", pattern: /\bturbo\b|\bvitest\b/ },
  { label: "full test suite", pattern: /\bpnpm\s+(?:run\s+)?test\b/ },
  { label: "build", pattern: /\bpnpm\s+(?:run\s+)?build\b/ },
  { label: "coverage", pattern: /\bcoverage\b/ },
  { label: "typecheck", pattern: /\btypecheck\b/ },
  {
    label: "service start",
    pattern:
      /\bwrangler\b|\bdev:worker\b|\bdev:relay\b|\bdocker\b|\bpnpm\s+(?:run\s+)?(?:dev|start|serve|stress:\w+)\b/,
  },
];

export function hookCommandLines(hookText) {
  return hookText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// Every command the hook can transitively invoke: its own lines plus the
// lint-staged mapping commands.
export function reachableCommands(hookText, mappings) {
  return [
    ...hookCommandLines(hookText),
    ...mappings.flatMap((mapping) => mapping.commands),
  ];
}

export function heavyCommandProblems(commands) {
  const problems = [];
  for (const command of commands) {
    for (const { label, pattern } of HEAVY_PATTERNS) {
      if (pattern.test(command)) {
        problems.push(`pre-commit path reaches a ${label} command: ${command}`);
      }
    }
  }
  return problems;
}

// Run strings of every ci.yml step that performs linting. A parse failure is
// reported as a single problem entry and no runs.
export function ciLintRuns(ciSource) {
  let doc;
  try {
    doc = parseYaml(ciSource);
  } catch (error) {
    return { runs: [], error: `ci.yml parse error: ${error.message}` };
  }
  const runs = [];
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      const run = typeof step?.run === "string" ? step.run.trim() : "";
      const name = typeof step?.name === "string" ? step.name : "";
      if (
        LINT_STEP_NAME.test(name) ||
        PNPM_LINT_RUN.test(run) ||
        ULTRACITE_RUN.test(run)
      ) {
        runs.push(run);
      }
    }
  }
  return { runs, error: null };
}

function lintScriptProblems(lintScript) {
  if (typeof lintScript !== "string" || lintScript.trim() === "") {
    return ["root package.json has no lint script"];
  }
  const problems = [];
  if (ULTRACITE_SUBCOMMAND.exec(lintScript)?.[1] !== "check") {
    problems.push(
      `root lint script must run \`ultracite check\`, found: ${lintScript}`
    );
  }
  if (!FULL_TREE_ARG.test(lintScript)) {
    problems.push(
      `root lint script must target the full tree (\`.\`), found: ${lintScript}`
    );
  }
  if (DIVERGENCE_FLAG.test(lintScript)) {
    problems.push(
      `root lint script overrides the shared rule set: ${lintScript}`
    );
  }
  return problems;
}

function ciLintProblems(runs) {
  if (runs.length === 0) {
    return ["ci.yml has no lint step"];
  }
  return runs.flatMap((run) =>
    PNPM_LINT_RUN.test(run)
      ? []
      : [
          `ci.yml lint step must delegate to the root \`pnpm lint\` script, found: ${run}`,
        ]
  );
}

function mappingProblems(mappings) {
  const problems = [];
  if (mappings.length === 0) {
    problems.push("lint-staged config declares no mappings");
  }
  for (const mapping of mappings) {
    for (const command of mapping.commands) {
      if (!ULTRACITE_SUBCOMMAND.test(command)) {
        problems.push(
          `staged command must invoke the ultracite binary, found: ${command}`
        );
      }
      if (FULL_TREE_ARG.test(command)) {
        problems.push(
          `staged command widens scope beyond the index set, found: ${command}`
        );
      }
      if (DIVERGENCE_FLAG.test(command)) {
        problems.push(
          `staged command overrides the shared rule set: ${command}`
        );
      }
    }
  }
  return problems;
}

function hookLineProblems(hookText) {
  return hookCommandLines(hookText).flatMap((line) =>
    HOOK_EXECUTABLE.test(line)
      ? []
      : [`hook runs a non-lint-staged command: ${line}`]
  );
}

function biomeConfigProblems(biomeConfigs, biomeSource) {
  const problems = [];
  if (biomeConfigs.length !== 1 || biomeConfigs[0] !== BIOME_CONFIG) {
    problems.push(
      `expected exactly one biome config (${BIOME_CONFIG}), found: ${
        biomeConfigs.join(", ") || "none"
      }`
    );
  }
  try {
    const config = parseJsonc(biomeSource);
    const extensions = Array.isArray(config?.extends) ? config.extends : [];
    if (!extensions.some((entry) => ULTRACITE_EXTENDS.test(String(entry)))) {
      problems.push("biome.jsonc does not extend the ultracite rule set");
    }
  } catch (error) {
    problems.push(`biome.jsonc parse error: ${error.message}`);
  }
  return problems;
}

// Full parity verdict over injected surfaces (pure; fixtures feed this).
export function parityProblems({
  lintScript,
  ciSource,
  hookText,
  mappings,
  biomeConfigs,
  biomeSource,
}) {
  const { runs, error } = ciLintRuns(ciSource);
  return [
    ...lintScriptProblems(lintScript),
    ...(error === null ? ciLintProblems(runs) : [error]),
    ...mappingProblems(mappings),
    ...hookLineProblems(hookText),
    ...heavyCommandProblems(reachableCommands(hookText, mappings)),
    ...biomeConfigProblems(biomeConfigs, biomeSource),
  ];
}

// Tracked biome config files: the single source of the shared rule set.
export function trackedBiomeConfigs() {
  const result = spawnSync("git", ["ls-files"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .filter((path) => BIOME_FILE.test(path))
    .sort();
}

// Parity verdict over the committed repository surfaces.
export function committedParityProblems() {
  const pkg = JSON.parse(readRepoFile("package.json") ?? "{}");
  const located = locateConfig(pkg);
  const parsed = located
    ? parseConfig(located.source, located.raw)
    : { mappings: [], errors: ["no lint-staged config found"] };
  return [
    ...parsed.errors,
    ...parityProblems({
      lintScript: pkg.scripts?.lint,
      ciSource: readRepoFile(CI_WORKFLOW) ?? "",
      hookText: readRepoFile(HOOK_PATH) ?? "",
      mappings: parsed.mappings,
      biomeConfigs: trackedBiomeConfigs(),
      biomeSource: readRepoFile(BIOME_CONFIG) ?? "",
    }),
  ];
}
