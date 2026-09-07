import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const SKILLS_DIR = ".factory/skills";
export const AGENTS_FILE = "AGENTS.md";
export const SKILL_FILE = "SKILL.md";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const CODE_SPAN = /`([^`]+)`/g;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const LEADING_DOT_SLASH = /^\.\//;
const TRAILING_SLASH = /\/$/;
const PATH_TOKEN = /^\.{0,2}\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/;
const PATH_EXT = /\.(?:md|mjs|mts|ts|tsx|js|json|jsonc|ya?ml)$/;
const PNPM_TOKEN = /\bpnpm\s+(?:run\s+)?([a-z][a-z0-9:_-]*)/gi;
const SKILL_REF = /\.factory\/skills\/([a-z0-9][a-z0-9-]*)/g;

// pnpm subcommands that are built-ins, not repository scripts, so a skill that
// names them is not asserting a package.json script (VAL-GOV-037).
const PNPM_BUILTINS = new Set([
  "install",
  "add",
  "remove",
  "update",
  "up",
  "exec",
  "dlx",
  "why",
  "list",
  "ls",
  "import",
  "link",
  "unlink",
  "store",
  "dedupe",
  "prune",
  "rebuild",
  "create",
  "init",
  "patch",
  "pack",
  "whoami",
  "config",
  "setup",
  "env",
  "root",
  "bin",
  "outdated",
  "licenses",
]);

// Destructive/external action tokens that a skill may only mention with
// deferral wording (VAL-GOV-039).
const ACTION_TOKENS =
  /\b(?:push(?:ing|es)?|publish(?:ing|es)?|deploy(?:ing|ment|s)?|wrangler|telegram)\b|--force|rm\s+-rf/i;
const DEFERRAL_MARKER =
  /\b(?:deferred|external|out of scope|never|not\b|no\b|do not|don't|avoid|forbidden|must not|out-of-scope)\b/i;
// Credentials and absolute host paths are never allowed, deferral or not.
const HARD_HITS =
  /\/home\/|\/Users\/|\/mnt\/|AI_API_KEY\s*=|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}/;

export function skillDirs(root = ".") {
  const base = join(root, SKILLS_DIR);
  if (!existsSync(base)) {
    return [];
  }
  return readdirSync(base).filter((entry) => {
    const full = join(base, entry);
    return statSync(full).isDirectory() && !entry.startsWith(".");
  });
}

// Skill directories that hold a SKILL.md (VAL-GOV-035).
export function skillFiles(root = ".") {
  return skillDirs(root)
    .map((dir) => ({ dir, file: join(root, SKILLS_DIR, dir, SKILL_FILE) }))
    .filter((entry) => existsSync(entry.file));
}

export function readSkill(file) {
  return readFileSync(file, "utf8");
}

export function parseSkill(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    return { data: null, body: text };
  }
  let data = null;
  try {
    data = parse(match[1]);
  } catch {
    data = null;
  }
  return { data, body: match[2] };
}

// Frontmatter/body problems for a single SKILL.md (VAL-GOV-036).
export function skillErrors(text) {
  const errors = [];
  const { data, body } = parseSkill(text);
  if (!data || typeof data !== "object") {
    return ["missing or unparseable frontmatter"];
  }
  if (typeof data.name !== "string" || !KEBAB.test(data.name)) {
    errors.push("name must be kebab-case");
  }
  if (typeof data.description !== "string" || data.description.trim() === "") {
    errors.push("description must be non-empty");
  }
  if (body.trim() === "") {
    errors.push("body must be non-empty");
  }
  return errors;
}

function candidateTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(CODE_SPAN)) {
    tokens.push(match[1]);
  }
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    tokens.push(match[1].split("#")[0]);
  }
  return tokens;
}

// A code-span/link token that looks like a concrete repo-relative path: it has
// a path separator or a known file extension, no glob, and no URL scheme.
function isRepoPath(token) {
  const value = token.trim();
  if (value === "" || value.includes("*") || value.includes("://")) {
    return false;
  }
  if (!PATH_TOKEN.test(value)) {
    return false;
  }
  return value.includes("/") || PATH_EXT.test(value);
}

// Repo-relative paths referenced in a skill that do not resolve (VAL-GOV-037).
export function unresolvedPaths(text, root = ".") {
  const bad = [];
  for (const token of candidateTokens(text)) {
    if (!isRepoPath(token)) {
      continue;
    }
    const rel = token
      .trim()
      .replace(LEADING_DOT_SLASH, "")
      .replace(TRAILING_SLASH, "");
    if (!existsSync(join(root, rel))) {
      bad.push(token.trim());
    }
  }
  return [...new Set(bad)];
}

export function pnpmTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(PNPM_TOKEN)) {
    const token = match[1];
    if (!PNPM_BUILTINS.has(token)) {
      tokens.push(token);
    }
  }
  return [...new Set(tokens)];
}

export function rootScripts(root = ".") {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return new Set(Object.keys(pkg.scripts ?? {}));
}

// pnpm script tokens in a skill absent from root package.json (VAL-GOV-037).
export function unknownPnpmTokens(text, root = ".") {
  const scripts = rootScripts(root);
  return pnpmTokens(text).filter((token) => !scripts.has(token));
}

// Skill directory names documented via `.factory/skills/<name>` (VAL-GOV-038).
export function documentedSkills(text) {
  return new Set([...text.matchAll(SKILL_REF)].map((match) => match[1]));
}

export function agentsReferencesSkills(root = ".") {
  const text = readFileSync(join(root, AGENTS_FILE), "utf8");
  return text.includes(`${SKILLS_DIR}/`) || documentedSkills(text).size > 0;
}

// Symmetric difference of documented vs actual skill dirs (VAL-GOV-038).
export function skillDocMismatch(root = ".") {
  const documented = documentedSkills(
    readFileSync(join(root, AGENTS_FILE), "utf8")
  );
  const actual = new Set(skillDirs(root));
  const undocumented = [...actual].filter((name) => !documented.has(name));
  const missing = [...documented].filter((name) => !actual.has(name));
  return { undocumented, missing };
}

// Lines instructing destructive/external actions or embedding secrets/host
// paths, minus lines whose action tokens carry deferral wording (VAL-GOV-039).
export function destructiveHits(text) {
  const hits = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (HARD_HITS.test(line)) {
      hits.push(line);
      continue;
    }
    if (ACTION_TOKENS.test(line) && !DEFERRAL_MARKER.test(line)) {
      hits.push(line);
    }
  }
  return hits;
}
