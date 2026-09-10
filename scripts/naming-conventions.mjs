import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { parseJsonc } from "./jsonc.mjs";

export const DOC_PATH = "CONTRIBUTING.md";
export const BIOME_CONFIG_PATH = "biome.jsonc";

// Naming rules this invariant keeps coherent between the documented naming
// conventions and the static-analysis toolchain (biome.jsonc + the ultracite
// config it extends).
export const NAMING_RULES = [
  "style/useNamingConvention",
  "style/useFilenamingConvention",
];

// Subjects the naming-convention documentation must cover (VAL-LOCAL-012):
// package naming, file naming, and identifier naming for variables,
// functions, constants, types, and classes. Each keyword must match at least
// one documented table row subject.
export const REQUIRED_SUBJECTS = [
  { id: "package", pattern: /package/i },
  { id: "file", pattern: /file/i },
  { id: "variable", pattern: /variable/i },
  { id: "function", pattern: /function/i },
  { id: "constant", pattern: /constant/i },
  { id: "type", pattern: /type/i },
  { id: "class", pattern: /class/i },
];

const NAMING_SECTION_HEADING = /^##\s+.*naming convention/i;
const ANY_SECTION_HEADING = /^##\s+/;
const TABLE_ROW = /^\|(.+)\|\s*$/;
const SEPARATOR_CELL = /^:?-{3,}:?$/;
const BACKTICK_TOKEN = /`([^`]+)`/;
const HEADER_SUBJECT = /^subject$/i;
const STATUS_ENFORCED = /^enforced/i;
const STATUS_ADVISORY = /^advisory/i;
const RULE_ID_TOKEN = /^[a-z]+\/[a-zA-Z]+$/;
const ADVISORY_MARKERS = new Set(["—", "-", "–", ""]);

// Extract the markdown body of the naming-conventions section of a document.
export function namingSection(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => NAMING_SECTION_HEADING.test(line));
  if (start === -1) {
    return "";
  }
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (ANY_SECTION_HEADING.test(line)) {
      break;
    }
    body.push(line);
  }
  return body.join("\n");
}

function parseRowStatus(statusCell) {
  if (STATUS_ENFORCED.test(statusCell)) {
    return "enforced";
  }
  if (STATUS_ADVISORY.test(statusCell)) {
    return "advisory";
  }
  return null;
}

function parseRowRuleId(toolingCell) {
  if (ADVISORY_MARKERS.has(toolingCell)) {
    return null;
  }
  // Bare rule ids (style/useNamingConvention) are the canonical form in the
  // doc: a backticked span containing a slash would be misread as a cited
  // repo path by the governance link checker.
  if (RULE_ID_TOKEN.test(toolingCell)) {
    return toolingCell;
  }
  return BACKTICK_TOKEN.exec(toolingCell)?.[1] ?? null;
}

// Parse the naming-convention table rows of a document. Each row yields
// { subject, convention, status, ruleId } where status is "enforced" or
// "advisory" (null when the cell matches neither) and ruleId is the biome
// rule id for enforced rows (null for advisory rows).
export function parseDocumentedRules(text) {
  const section = namingSection(text);
  const rows = [];
  for (const line of section.split("\n")) {
    const match = TABLE_ROW.exec(line.trim());
    if (!match) {
      continue;
    }
    const cells = match[1].split("|").map((cell) => cell.trim());
    if (cells.length < 4) {
      continue;
    }
    if (cells.every((cell) => SEPARATOR_CELL.test(cell))) {
      continue;
    }
    if (HEADER_SUBJECT.test(cells[0])) {
      continue;
    }
    const [subject, convention, statusCell, toolingCell] = cells;
    rows.push({
      subject,
      convention,
      status: parseRowStatus(statusCell),
      ruleId: parseRowRuleId(toolingCell),
    });
  }
  return rows;
}

// Subjects from REQUIRED_SUBJECTS with no matching documented row.
export function missingSubjects(rows) {
  return REQUIRED_SUBJECTS.filter(
    ({ pattern }) => !rows.some((row) => pattern.test(row.subject))
  ).map(({ id }) => id);
}

// Resolve the effective linter rules: each extended config is applied first,
// then the root biome.jsonc overrides it, merged per rule group.
export function effectiveLinterRules(root = ".") {
  const require = createRequire(resolve(join(root, "package.json")));
  const localConfig = parseJsonc(
    readFileSync(join(root, BIOME_CONFIG_PATH), "utf8")
  );
  const configs = [];
  for (const entry of localConfig.extends ?? []) {
    if (entry === "//") {
      continue;
    }
    configs.push(parseJsonc(readFileSync(require.resolve(entry), "utf8")));
  }
  configs.push(localConfig);
  const merged = {};
  for (const config of configs) {
    const groups = config?.linter?.rules ?? {};
    for (const [group, rules] of Object.entries(groups)) {
      if (rules && typeof rules === "object") {
        merged[group] = { ...(merged[group] ?? {}), ...rules };
      }
    }
  }
  const flat = {};
  for (const [group, rules] of Object.entries(merged)) {
    for (const [rule, value] of Object.entries(rules)) {
      flat[`${group}/${rule}`] = value;
    }
  }
  return flat;
}

// A rule counts as configured (enforcing) unless it is absent or set to "off".
export function isRuleEnabled(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value !== "off";
  }
  if (typeof value === "object") {
    return value.level !== "off";
  }
  return false;
}

// Doc/config coherence (VAL-LOCAL-014). Both contradiction directions fail
// with a message naming the rule: documented-as-enforced but not configured,
// or a configured naming rule that the documentation does not mention.
export function coherenceViolations(rows, effectiveRules) {
  const violations = [];
  const enforcedRows = rows.filter((row) => row.status === "enforced");
  for (const row of enforcedRows) {
    if (!row.ruleId) {
      violations.push(
        `${row.subject}: documented as enforced but names no tooling rule id`
      );
      continue;
    }
    if (!isRuleEnabled(effectiveRules[row.ruleId])) {
      violations.push(
        `${row.ruleId}: documented as enforced for "${row.subject}" but not configured (or set to "off") in the toolchain`
      );
    }
  }
  for (const ruleId of NAMING_RULES) {
    const documented = rows.some((row) => row.ruleId === ruleId);
    if (isRuleEnabled(effectiveRules[ruleId]) && !documented) {
      violations.push(
        `${ruleId}: configured in the toolchain but missing from the documented naming conventions`
      );
    }
  }
  return violations;
}
