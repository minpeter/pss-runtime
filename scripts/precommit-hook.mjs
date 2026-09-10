import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// Invariant helpers for the Husky + lint-staged pre-commit gate
// (VAL-LOCAL-001 .. VAL-LOCAL-007). Everything here is deterministic,
// offline, and decidable from committed repository files.

export const HOOK_PATH = ".husky/pre-commit";
export const CONFIG_CANDIDATES = [
  ".lintstagedrc.json",
  ".lintstagedrc",
  ".lintstagedrc.yaml",
  ".lintstagedrc.yml",
];

// Extensions the Biome/Ultracite toolchain lints and formats.
export const LINTABLE_EXTENSIONS = new Set([
  "cjs",
  "css",
  "cts",
  "graphql",
  "js",
  "jsx",
  "json",
  "jsonc",
  "mjs",
  "mts",
  "ts",
  "tsx",
]);

const CATCH_ALL_PATTERNS = new Set(["*", "**", "**/*", "**/**"]);

const WHITESPACE_SPLIT = /\s+/;
const HUSKY_TOKEN = /\bhusky\b/;
const LINT_STAGED_TOKEN = /\blint-staged\b/;
const SWALLOWED_EXIT = /\|\|\s*(true|exit 0)|;\s*exit 0/;
const YAML_SOURCE = /\.ya?ml$/;
const BRACE_EXTENSIONS = /\.\{([^}]*)\}/g;
const SUFFIX_EXTENSION = /\.([A-Za-z0-9]+)$/;
const HAS_EXTENSION_SYNTAX = /[.{]/;
const GIT_ADD_COMMAND = /(^|\s)git\s+add(\s|$)/;
const HUSKY_INTERNAL_IGNORE = /^\.husky\/_\/?$/m;

// Hook artifacts must never carry URLs or credential-shaped material and the
// hook itself must run fully offline (VAL-LOCAL-007).
const FORBIDDEN_CONTENT = [
  /https?:\/\//,
  /ghp_[A-Za-z0-9]{16,}/,
  /sk-[A-Za-z0-9]{16,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /NPM_TOKEN/,
  /\b(?:curl|wget|fetch)\b/,
];

// Binaries a lint-staged command (or the hook) may invoke. Everything is a
// local toolchain binary; no network-capable tool is allowed.
const ALLOWED_BINARIES = new Set(["lint-staged", "node", "ultracite"]);

export function readRepoFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function readRootPackage() {
  return JSON.parse(readFileSync("package.json", "utf8"));
}

export function trackedFilesUnder(dir) {
  const result = spawnSync("git", ["ls-files", "--", dir], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split("\n").filter(Boolean);
}

export function trackedFileMode(path) {
  const result = spawnSync("git", ["ls-files", "-s", "--", path], {
    encoding: "utf8",
  });
  if (result.status !== 0 || result.stdout.trim() === "") {
    return null;
  }
  return result.stdout.trim().split(WHITESPACE_SPLIT)[0];
}

// --- hook wiring -----------------------------------------------------------

export function wiringProblems(pkg = readRootPackage()) {
  const problems = [];
  const prepare = pkg.scripts?.prepare ?? "";
  if (!HUSKY_TOKEN.test(prepare)) {
    problems.push("package.json scripts.prepare does not install husky hooks");
  }
  for (const dep of ["husky", "lint-staged"]) {
    if (!pkg.devDependencies?.[dep]) {
      problems.push(`missing pinned devDependency: ${dep}`);
    }
  }
  return problems;
}

export function hookProblems(hookText) {
  const problems = [];
  if (hookText === null) {
    return [`${HOOK_PATH} is missing`];
  }
  if (hookText.trim() === "") {
    problems.push(`${HOOK_PATH} is empty`);
  }
  if (!LINT_STAGED_TOKEN.test(hookText)) {
    problems.push("hook does not invoke lint-staged");
  }
  if (SWALLOWED_EXIT.test(hookText)) {
    problems.push("hook swallows the lint exit code");
  }
  return problems;
}

// --- lint-staged config ----------------------------------------------------

export function locateConfig(pkg = readRootPackage()) {
  for (const candidate of CONFIG_CANDIDATES) {
    if (existsSync(candidate)) {
      return { source: candidate, raw: readRepoFile(candidate) };
    }
  }
  if (pkg["lint-staged"]) {
    return {
      source: "package.json#lint-staged",
      raw: JSON.stringify(pkg["lint-staged"]),
    };
  }
  return null;
}

export function parseConfig(source, raw) {
  const errors = [];
  let parsed;
  try {
    parsed = YAML_SOURCE.test(source) ? parseYaml(raw) : JSON.parse(raw);
  } catch (error) {
    return { mappings: [], errors: [`config parse error: ${error.message}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("lint-staged config must be an object of pattern -> command");
    return { mappings: [], errors };
  }
  const mappings = Object.entries(parsed).map(([pattern, value]) => ({
    pattern,
    commands: (Array.isArray(value) ? value : [value]).map(String),
  }));
  for (const mapping of mappings) {
    if (mapping.commands.some((command) => command.trim() === "")) {
      errors.push(`pattern ${mapping.pattern} maps to an empty command`);
    }
  }
  return { mappings, errors };
}

export function patternExtensions(pattern) {
  const extensions = [];
  for (const match of pattern.matchAll(BRACE_EXTENSIONS)) {
    for (const part of match[1].split(",")) {
      extensions.push(part.trim());
    }
  }
  const suffix = pattern.match(SUFFIX_EXTENSION);
  if (suffix) {
    extensions.push(suffix[1]);
  }
  return extensions;
}

export function patternProblems(pattern) {
  const problems = [];
  const normalized = pattern.trim();
  if (
    CATCH_ALL_PATTERNS.has(normalized) ||
    !HAS_EXTENSION_SYNTAX.test(normalized)
  ) {
    problems.push(`catch-all or extension-less pattern: ${pattern}`);
    return problems;
  }
  const extensions = patternExtensions(normalized);
  if (extensions.length === 0) {
    problems.push(`pattern targets no extension: ${pattern}`);
  }
  for (const extension of extensions) {
    if (!LINTABLE_EXTENSIONS.has(extension)) {
      problems.push(
        `pattern ${pattern} targets non-lintable extension .${extension}`
      );
    }
  }
  return problems;
}

export function commandProblems(command) {
  const problems = [];
  const tokens = command.trim().split(WHITESPACE_SPLIT);
  if (GIT_ADD_COMMAND.test(command)) {
    problems.push(`command stages paths itself (index-escaping): ${command}`);
  }
  if (tokens.includes(".") || tokens.some((token) => token.startsWith("/"))) {
    problems.push(
      `command references paths outside the staged file set: ${command}`
    );
  }
  const binary =
    tokens[0] === "pnpm" && tokens[1] === "exec" ? tokens[2] : tokens[0];
  if (!ALLOWED_BINARIES.has(binary)) {
    problems.push(`command uses a non-allowlisted binary: ${binary}`);
  }
  return problems;
}

export function configProblems(mappings) {
  if (mappings.length === 0) {
    return ["lint-staged config declares no pattern mappings"];
  }
  return mappings.flatMap((mapping) => [
    ...patternProblems(mapping.pattern),
    ...mapping.commands.flatMap(commandProblems),
  ]);
}

// --- secret/network hygiene (VAL-LOCAL-007) ---------------------------------

export function forbiddenContentProblems(label, text) {
  return FORBIDDEN_CONTENT.filter((pattern) => pattern.test(text)).map(
    (pattern) => `${label} contains forbidden content matching ${pattern}`
  );
}

// --- hook inventory / ignore hygiene (VAL-LOCAL-006) -------------------------

export function extraHookProblems() {
  return trackedFilesUnder(".husky")
    .filter((path) => path !== HOOK_PATH)
    .map((path) => `unexpected tracked hook artifact: ${path}`);
}

export function ignoreProblems() {
  const gitignore = readRepoFile(".gitignore") ?? "";
  if (HUSKY_INTERNAL_IGNORE.test(gitignore)) {
    return [];
  }
  if (readRepoFile(".husky/_/.gitignore") !== null) {
    return [];
  }
  return ["husky internals (.husky/_/) are not gitignored"];
}
