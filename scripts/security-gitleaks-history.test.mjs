import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gitleaksConfigProblems } from "./security-gitleaks-config.mjs";

const config = readFileSync(".gitleaks.toml", "utf8");
const firstRule = config.indexOf("[[rules]]");
const prefix = config.slice(0, firstRule);
const history = config.slice(firstRule);
const FIRST_PATHS = /^paths = \[[^\n]+\]$/m;
const FIRST_VALUES = /^regexes = \[[\s\S]*?\]/m;
const WRONG_PATH = "paths = ['''^unapproved/file\\.txt$''']";
const WRONG_VALUE = "regexes = ['''^UNAPPROVED_VALUE$''']";
const PLACEHOLDER = String.raw`^[A-Z0-9_]+(API_KEY|TOKEN|SECRET)=\.\.\.$`;
const REGEXES_ARRAY = /^regexes = \[[\s\S]*?^\]/m;
const PLACEHOLDER_LITERAL = /'''([^']+)'''/;

function mutateHistory(before, after) {
  const mutated = history.replace(before, () => after);
  expect(mutated).not.toBe(history);
  return prefix + mutated;
}

describe("global Gitleaks placeholder exclusions", () => {
  it("accepts the shipped placeholder pattern", () => {
    expect(prefix).toContain(`'''${PLACEHOLDER}'''`);
    expect(gitleaksConfigProblems(config)).toEqual([]);
  });

  it.each([
    String.raw`^\.env\.example$`,
    String.raw`^apps/worker-agent/\.dev\.vars\.example$`,
    String.raw`^examples/evals/\.env\.example$`,
    ".*",
  ])("rejects whole-file suppression %s in valid TOML", (path) => {
    const mutated = prefix.replace(
      "[allowlist]",
      () => `[allowlist]\npaths = ['''${path}''']`
    );
    expect(gitleaksConfigProblems(mutated + history)).not.toEqual([]);
  });

  it.each(['regexTarget = "secret"', 'regexTarget = "match"', ""])(
    "rejects a non-line placeholder target %s in valid TOML",
    (target) => {
      const mutated = prefix.replace('regexTarget = "line"', target);
      expect(gitleaksConfigProblems(mutated + history)).not.toEqual([]);
    }
  );

  it.each(["regexes = []", ""])(
    "rejects missing placeholder regexes %s in valid TOML",
    (replacement) => {
      const mutated = prefix.replace(REGEXES_ARRAY, replacement);
      expect(gitleaksConfigProblems(mutated + history)).not.toEqual([]);
    }
  );

  it("accepts only placeholder lines, not credential values or suffixes", () => {
    const pattern = prefix.match(PLACEHOLDER_LITERAL)[1];
    const regex = new RegExp(pattern);
    expect(regex.test("AI_API_KEY=...")).toBe(true);
    expect(regex.test("AI_API_KEY=" . ("0123456789abcdef" x 2))).toBe(false);
    expect(regex.test("AI_API_KEY=... trailing-secret")).toBe(false);
    expect(regex.test("prefix AI_API_KEY=...")).toBe(false);
  });

  it.each([".*SECRET.*", "^[A-Z]+SECRET[A-Z]+$", "^.*TOKEN.*$"])(
    "rejects broad global regex %s in valid TOML",
    (pattern) => {
      // Replace the literal, not the array: character classes contain ].
      // A callback preserves $ followed by TOML's literal-string quotes.
      const mutated = prefix.replace(
        `'''${PLACEHOLDER}'''`,
        () => `'''${pattern}'''`
      );
      expect(mutated).not.toBe(prefix);
      expect(mutated).toContain(`'''${pattern}'''`);
      expect(gitleaksConfigProblems(mutated + history).length).toBeGreaterThan(
        0
      );
    }
  );
});

describe("historical Gitleaks exclusions", () => {
  it("accepts the reviewed commit/path/value conjunctions", () => {
    expect(gitleaksConfigProblems(config)).toEqual([]);
  });

  it.each([
    ["condition", 'condition = "AND"', 'condition = "OR"'],
    [
      "commit",
      'commits = ["2710b291e3454d64648ca79696b61f385325be81"]',
      "commits = []",
    ],
    ["path", FIRST_PATHS, "paths = ['''^.*$''']"],
    ["value", FIRST_VALUES, "regexes = ['''^.*$''']"],
    ["target", 'regexTarget = "secret"', 'regexTarget = "line"'],
    [
      "rule override",
      'id = "generic-api-key"',
      'id = "generic-api-key"\nregex = "never-match"',
    ],
    [
      "extra field",
      'condition = "AND"',
      'condition = "AND"\nstopwords = ["token"]',
    ],
    [
      "indented extra field",
      'condition = "AND"',
      'condition = "AND"\n  stopwords = ["token"]',
    ],
    [
      "quoted extra field",
      'condition = "AND"',
      'condition = "AND"\n"stopwords" = ["token"]',
    ],
  ])("rejects a widened %s gate in valid TOML", (_label, before, after) => {
    expect(
      gitleaksConfigProblems(mutateHistory(before, after)).length
    ).toBeGreaterThan(0);
  });

  it.each([
    ["paths", FIRST_PATHS, WRONG_PATH],
    ["regexes", FIRST_VALUES, WRONG_VALUE],
  ])("rejects unparsed mixed-quote %s entries", (_label, before, exact) => {
    const mixed = `${exact.slice(0, -1)}, ".*"]`;
    expect(
      gitleaksConfigProblems(mutateHistory(before, mixed)).length
    ).toBeGreaterThan(0);
  });
});

const DESCRIPTION = /^description = "[^"\n]*"$/m;

describe("complete Gitleaks configuration parsing", () => {
  it.each([
    [
      "paths",
      FIRST_PATHS,
      "paths = ['''^]",
      "paths = ['''^unapproved/file$''']",
    ],
    ["regexes", FIRST_VALUES, "regexes = ['''^]", WRONG_VALUE],
  ])("does not read %s from description text", (_key, target, broad, decoy) => {
    const actual = `${broad.slice(0, -1)}''']`;
    const mutated = history
      .replace(DESCRIPTION, () => `description = "${decoy}"`)
      .replace(target, () => actual);
    expect(gitleaksConfigProblems(prefix + mutated).length).toBeGreaterThan(0);
  });

  it("rejects spaced rule headers hiding OR allowlists", () => {
    const mutated = config
      .replaceAll("[[rules]]", "[[ rules ]]")
      .replaceAll('condition = "AND"', 'condition = "OR"');
    expect(gitleaksConfigProblems(mutated).length).toBeGreaterThan(0);
  });

  it.each([
    "[[rules]",
    "[[ rules ]]",
    "[[rules.allowlists]",
    "[unknown]",
    "trailing garbage",
    '"paths" = [".*"]',
  ])("rejects unconsumed suffix %s", (suffix) => {
    expect(
      gitleaksConfigProblems(`${config}\n${suffix}\n`).length
    ).toBeGreaterThan(0);
  });
});
