import { parse } from "yaml";

const PACKAGES_SECTION_PATTERN = /^packages:\n(?<body>(?:(?: {2}[^\n]*)?\n)*)/m;
const PACKAGE_KEY_PATTERN = /^ {2}(?:'(?<quoted>[^']+)'|(?<bare>\S[^:]*)):/;
const PEER_SUFFIX_PATTERN = /\([^)]*\)$/;
const VERSION_START_PATTERN = /^\d/;

// Parses pnpm-workspace.yaml, returning { config, error }. A syntactically
// malformed document yields a named error instead of throwing.
export function parseWorkspaceConfig(source) {
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

// pnpm documents minimumReleaseAge as a number of minutes. An explicit,
// non-empty, positive duration is required; anything else is named here.
export function validateMinimumReleaseAge(config) {
  if (!("minimumReleaseAge" in config)) {
    return ["minimumReleaseAge: must be declared"];
  }
  const value = config.minimumReleaseAge;
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    return ["minimumReleaseAge: must be non-empty"];
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return [
      "minimumReleaseAge: must be a number of minutes (pnpm's supported duration format)",
    ];
  }
  if (value <= 0) {
    return [`minimumReleaseAge: must be positive, got ${value}`];
  }
  return [];
}

// Parses one minimumReleaseAgeExclude entry into { name, versions }.
// Supported shapes (pnpm v10.19+): "name", "@scope/*", "name@1.2.3", and
// disjunctions "name@1.2.3 || 2.0.0". Returns { error } when malformed.
export function parseExcludeEntry(entry) {
  if (typeof entry !== "string" || entry.trim() === "") {
    return {
      error: `entry ${JSON.stringify(entry)}: must be a non-empty string`,
    };
  }
  const parts = entry.split("||").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    return { error: `entry "${entry}": empty term in "||" disjunction` };
  }
  const { name, version } = splitNameVersion(parts[0]);
  if (name === "") {
    return { error: `entry "${entry}": missing package name` };
  }
  const versions = [];
  if (version !== null) {
    versions.push(version);
  }
  for (const extra of parts.slice(1)) {
    const reparsed = splitNameVersion(extra);
    versions.push(reparsed.name === "" ? extra : (reparsed.version ?? extra));
  }
  if (versions.some((item) => item === "")) {
    return { error: `entry "${entry}": empty version in disjunction` };
  }
  if (name.endsWith("*") && versions.length > 0) {
    return {
      error: `entry "${entry}": version-pinned wildcard is not supported`,
    };
  }
  return { name, versions };
}

// Splits "name@version" respecting the leading "@" of scoped names. A bare
// name yields version null.
function splitNameVersion(selector) {
  const at = selector.startsWith("@")
    ? selector.indexOf("@", 1)
    : selector.indexOf("@");
  if (at === -1) {
    return { name: selector, version: null };
  }
  return { name: selector.slice(0, at), version: selector.slice(at + 1) };
}

// Extracts resolved package versions from the lockfile "packages:" section
// only (not overrides or snapshots), returning Map<name, Set<version>>.
export function readLockfilePackageIndex(source) {
  const index = new Map();
  const section = source.match(PACKAGES_SECTION_PATTERN);
  if (!section?.groups) {
    throw new Error('pnpm-lock.yaml must declare a "packages:" section');
  }
  for (const line of section.groups.body.split("\n")) {
    const key = line.match(PACKAGE_KEY_PATTERN);
    const raw = key?.groups?.quoted ?? key?.groups?.bare;
    if (!raw) {
      continue;
    }
    const { name, version } = splitNameVersion(
      raw.replace(PEER_SUFFIX_PATTERN, "")
    );
    if (
      name === "" ||
      version === null ||
      !VERSION_START_PATTERN.test(version)
    ) {
      continue;
    }
    if (!index.has(name)) {
      index.set(name, new Set());
    }
    index.get(name).add(version);
  }
  return index;
}

// pnpm applies exclusions by package name (a pinned version narrows the
// exemption to that version). The liveness rule here: every entry must still
// name at least one package version resolved in the lockfile, so a stale
// exemption cannot linger after its package leaves the dependency graph.
export function resolveExcludes(entries, lockIndex) {
  const problems = [];
  const resolutions = [];
  for (const entry of entries) {
    const parsed = parseExcludeEntry(entry);
    if (parsed.error) {
      problems.push(parsed.error);
      continue;
    }
    const matches = matchLockfileVersions(parsed.name, lockIndex);
    if (matches.length === 0) {
      problems.push(
        `minimumReleaseAgeExclude entry "${entry}" resolves to no package in pnpm-lock.yaml`
      );
      continue;
    }
    const pinnedHits = parsed.versions.filter((version) =>
      matches.some((match) => match.version === version)
    );
    if (parsed.versions.length > 0 && pinnedHits.length === 0) {
      problems.push(
        `minimumReleaseAgeExclude entry "${entry}" resolves to no pinned version in pnpm-lock.yaml`
      );
      continue;
    }
    resolutions.push({ entry, matches, pinnedHits });
  }
  return { problems, resolutions };
}

function matchLockfileVersions(name, lockIndex) {
  const matches = [];
  for (const [packageName, versions] of lockIndex) {
    const nameMatches = name.endsWith("/*")
      ? packageName.startsWith(name.slice(0, -1))
      : packageName === name;
    if (nameMatches) {
      for (const version of versions) {
        matches.push({ name: packageName, version });
      }
    }
  }
  return matches.sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  );
}

// The exclude list is part of the preserved policy: removing an entry or
// adding a new exemption must fail with the entry named.
export function validateExcludeList(entries, expectedEntries) {
  const problems = [];
  for (const expected of expectedEntries) {
    if (!entries.includes(expected)) {
      problems.push(`minimumReleaseAgeExclude: missing entry "${expected}"`);
    }
  }
  for (const entry of entries) {
    if (!expectedEntries.includes(entry)) {
      problems.push(
        `minimumReleaseAgeExclude: unexpected entry "${entry}" broadens the exemptions`
      );
    }
  }
  return problems;
}
