import { parse } from "yaml";

// Ecosystems the repository's Dependabot configuration must cover.
export const REQUIRED_ECOSYSTEMS = ["npm", "github-actions"];

// Parses Dependabot YAML, returning { config, error }. A syntactically
// malformed document yields a named error instead of throwing.
export function parseDependabotConfig(source) {
  try {
    const config = parse(source);
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config)
    ) {
      return { config: null, error: "document: must be a YAML mapping" };
    }
    return { config, error: null };
  } catch (cause) {
    return {
      config: null,
      error: `document: malformed YAML (${cause.message})`,
    };
  }
}

// Validates the parsed Dependabot config, returning problem strings that name
// the offending key. An empty array means the config satisfies the contract.
export function validateDependabotConfig(config) {
  const problems = [];
  if (config.version !== 2) {
    problems.push("version: must be 2");
  }
  if (!Array.isArray(config.updates) || config.updates.length === 0) {
    problems.push("updates: must be a non-empty list");
    return problems;
  }
  const byEcosystem = new Map();
  for (const [index, entry] of config.updates.entries()) {
    validateUpdateEntry(entry, index, problems);
    if (entry && typeof entry === "object") {
      byEcosystem.set(entry["package-ecosystem"], entry);
    }
  }
  for (const ecosystem of REQUIRED_ECOSYSTEMS) {
    if (!byEcosystem.has(ecosystem)) {
      problems.push(
        `updates: missing entry for package-ecosystem "${ecosystem}"`
      );
    }
  }
  problems.push(...findPrefixCollisions(config.updates));
  return problems;
}

function validateUpdateEntry(entry, index, problems) {
  const label =
    entry && typeof entry === "object" && entry["package-ecosystem"]
      ? `updates[${index}] "${entry["package-ecosystem"]}"`
      : `updates[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    problems.push(`${label}: must be a mapping`);
    return;
  }
  for (const key of [
    "package-ecosystem",
    "directory",
    "open-pull-requests-limit",
  ]) {
    if (entry[key] === undefined || entry[key] === null) {
      problems.push(`${label}: missing "${key}"`);
    }
  }
  const interval = entry.schedule?.interval;
  if (interval !== "weekly") {
    problems.push(`${label}: schedule.interval must be "weekly"`);
  }
  validateCommitMessagePrefix(entry, label, problems);
  validateGroups(entry, label, problems);
}

function validateCommitMessagePrefix(entry, label, problems) {
  const prefix = entry["commit-message"]?.prefix;
  if (typeof prefix !== "string" || prefix.trim() === "") {
    problems.push(`${label}: missing "commit-message.prefix"`);
  }
}

function validateGroups(entry, label, problems) {
  const groups = entry.groups;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
    problems.push(`${label}: missing "groups" block`);
    return;
  }
  const names = Object.keys(groups);
  if (names.length === 0) {
    problems.push(`${label}: "groups" must name at least one group`);
    return;
  }
  for (const name of names) {
    const group = groups[name];
    if (!group || typeof group !== "object") {
      problems.push(`${label}: group "${name}" must be a mapping`);
      continue;
    }
    const hasPatterns =
      Array.isArray(group.patterns) && group.patterns.length > 0;
    const hasUpdateTypes =
      Array.isArray(group["update-types"]) && group["update-types"].length > 0;
    if (!(hasPatterns || hasUpdateTypes)) {
      problems.push(
        `${label}: group "${name}" needs a patterns or update-types selection`
      );
    }
  }
}

// Commit-message prefixes must be pairwise distinct so grouped PRs are
// identifiable by title per ecosystem.
function findPrefixCollisions(updates) {
  const seen = new Map();
  const problems = [];
  for (const entry of updates) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const prefix = entry["commit-message"]?.prefix;
    if (typeof prefix !== "string" || prefix.trim() === "") {
      continue;
    }
    const other = seen.get(prefix);
    if (other === undefined) {
      seen.set(prefix, entry["package-ecosystem"]);
    } else {
      problems.push(
        `commit-message.prefix "${prefix}" collides between "${other}" and "${entry["package-ecosystem"]}"`
      );
    }
  }
  return problems;
}
