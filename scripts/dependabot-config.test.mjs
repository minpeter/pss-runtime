import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseDependabotConfig,
  validateDependabotConfig,
} from "./dependabot-config.mjs";

const CONFIG_PATH = ".github/dependabot.yml";
const MALFORMED_YAML_PATTERN = /malformed YAML/;
const REMOVED_ECOSYSTEM_PATTERN = /package-ecosystem "github-actions"/;
const MISSING_GROUPS_PATTERN = /"npm".*groups/;
const MISSING_LIMIT_PATTERN = /open-pull-requests-limit/;
const MISSING_PREFIX_PATTERN = /commit-message\.prefix/;
const COLLIDING_PREFIX_PATTERN = /collides/;

function readConfigSource() {
  return readFileSync(CONFIG_PATH, "utf8");
}

function readConfig() {
  const { config, error } = parseDependabotConfig(readConfigSource());
  expect(error).toBeNull();
  return config;
}

describe("dependabot: config structure (VAL-LOCAL-015)", () => {
  it("parses as valid YAML with version: 2 and required update entries", () => {
    const { config, error } = parseDependabotConfig(readConfigSource());
    expect(error).toBeNull();
    expect(config.version).toBe(2);
    const ecosystems = config.updates.map(
      (entry) => entry["package-ecosystem"]
    );
    expect(ecosystems).toContain("npm");
    expect(ecosystems).toContain("github-actions");
  });

  it("preserves directory, weekly schedule, and open-pull-requests-limit", () => {
    const config = readConfig();
    for (const entry of config.updates) {
      expect(entry.directory).toBe("/");
      expect(entry.schedule?.interval).toBe("weekly");
      expect(entry["open-pull-requests-limit"]).toBeGreaterThan(0);
    }
  });

  it("declares at least one named groups block per update entry", () => {
    const config = readConfig();
    expect(validateDependabotConfig(config)).toEqual([]);
    for (const entry of config.updates) {
      const names = Object.keys(entry.groups ?? {});
      expect(names.length).toBeGreaterThan(0);
    }
  });

  it("fails on malformed YAML naming the document", () => {
    const { error } = parseDependabotConfig("updates: [unclosed");
    expect(error).toMatch(MALFORMED_YAML_PATTERN);
  });

  it("fails when an existing ecosystem entry is removed, naming it", () => {
    const config = readConfig();
    const mutated = {
      ...config,
      updates: config.updates.filter(
        (entry) => entry["package-ecosystem"] !== "github-actions"
      ),
    };
    expect(validateDependabotConfig(mutated).join("\n")).toMatch(
      REMOVED_ECOSYSTEM_PATTERN
    );
  });

  it("fails when an update entry drops its groups block, naming the entry", () => {
    const config = readConfig();
    const mutated = {
      ...config,
      updates: config.updates.map((entry) => {
        if (entry["package-ecosystem"] !== "npm") {
          return entry;
        }
        const { groups: _dropped, ...rest } = entry;
        return rest;
      }),
    };
    expect(validateDependabotConfig(mutated).join("\n")).toMatch(
      MISSING_GROUPS_PATTERN
    );
  });

  it("fails when open-pull-requests-limit is removed, naming the key", () => {
    const config = readConfig();
    const mutated = {
      ...config,
      updates: config.updates.map((entry) => {
        const { "open-pull-requests-limit": _dropped, ...rest } = entry;
        return rest;
      }),
    };
    expect(validateDependabotConfig(mutated).join("\n")).toMatch(
      MISSING_LIMIT_PATTERN
    );
  });
});

describe("dependabot: commit-message prefixes (VAL-LOCAL-016)", () => {
  it("declares a prefix per entry and keeps them pairwise distinct", () => {
    const config = readConfig();
    const prefixes = config.updates.map(
      (entry) => entry["commit-message"]?.prefix
    );
    for (const prefix of prefixes) {
      expect(typeof prefix).toBe("string");
      expect(prefix.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("fails on a missing prefix, naming the entry", () => {
    const config = readConfig();
    const mutated = {
      ...config,
      updates: config.updates.map((entry) => {
        const { "commit-message": _dropped, ...rest } = entry;
        return rest;
      }),
    };
    expect(validateDependabotConfig(mutated).join("\n")).toMatch(
      MISSING_PREFIX_PATTERN
    );
  });

  it("fails on colliding prefixes, naming the collision", () => {
    const config = readConfig();
    const shared = config.updates[0]["commit-message"].prefix;
    const mutated = {
      ...config,
      updates: config.updates.map((entry) => ({
        ...entry,
        "commit-message": { ...entry["commit-message"], prefix: shared },
      })),
    };
    expect(validateDependabotConfig(mutated).join("\n")).toMatch(
      COLLIDING_PREFIX_PATTERN
    );
  });
});
