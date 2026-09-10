import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const TAXONOMY_PATH = "docs/label-taxonomy.md";
export const ISSUE_TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
export const PR_TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";
export const REFERENCING_DOCS = ["CONTRIBUTING.md", "AGENTS.md"];

// The three label categories the taxonomy must define as distinct sections.
export const REQUIRED_CATEGORIES = ["type", "priority", "area"];

// A GitHub label color is a 3- or 6-digit hex value with a leading `#`.
export const HEX_COLOR = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

const CONFIG_FILE = "config.yml";
const HEADING = /^##\s+(.*\S)\s*$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const SEPARATOR_ROW = /^[\s|:-]+$/;
const BACKTICK = /`/g;
const MARKDOWN_LINK = /\]\(([^)]+)\)/g;
const LEADING_DOT_SLASH = /^\.\//;
const PR_LABELS_DIRECTIVE = /<!--\s*labels:\s*([^>]+?)\s*-->/i;

// Remote-creation completion terms vs. explicit deferral markers (VAL-GOV-023).
const COMPLETION_TERM = /\b(?:created|enabled|active|deployed)\b|on github/i;
const DEFERRAL_MARKER = /\b(?:deferred|external|out of scope|planned)\b/i;
const REMOTE_MENTION = /on github|remote/i;

export function readTaxonomy(root = ".") {
  return readFileSync(join(root, TAXONOMY_PATH), "utf8");
}

function categoryOf(heading) {
  return REQUIRED_CATEGORIES.find((c) =>
    new RegExp(`\\b${c}\\b`, "i").test(heading)
  );
}

function cells(rowSource) {
  return rowSource.split("|").map((cell) => cell.trim());
}

function isHeaderRow(parts) {
  const first = parts[0]?.toLowerCase();
  return first === "name" || first === "label";
}

// Parse the `##` category sections and their markdown-table entries. Each entry
// is `{ name, color, purpose }`; header and separator rows are skipped.
export function parseSections(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const heading = raw.match(HEADING);
    if (heading) {
      current = {
        heading: heading[1],
        category: categoryOf(heading[1]),
        entries: [],
      };
      sections.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const row = raw.match(TABLE_ROW);
    if (!row || SEPARATOR_ROW.test(raw)) {
      continue;
    }
    const parts = cells(row[1]);
    if (parts.length < 3 || isHeaderRow(parts)) {
      continue;
    }
    current.entries.push({
      name: parts[0].replace(BACKTICK, "").trim(),
      color: parts[1].replace(BACKTICK, "").trim(),
      purpose: parts.slice(2).join(" | ").trim(),
    });
  }
  return sections;
}

export function allEntries(sections) {
  return sections.flatMap((section) => section.entries);
}

export function taxonomyNames(text) {
  return allEntries(parseSections(text)).map((entry) => entry.name);
}

// Categories that are missing entirely or have no label entry (VAL-GOV-020).
export function missingCategories(sections) {
  return REQUIRED_CATEGORIES.filter(
    (category) =>
      !sections.some(
        (section) => section.category === category && section.entries.length > 0
      )
  );
}

export function entryErrors(entry) {
  const errors = [];
  if (!entry.name) {
    errors.push("missing name");
  }
  if (!HEX_COLOR.test(entry.color)) {
    errors.push(`invalid color "${entry.color}"`);
  }
  if (!entry.purpose) {
    errors.push("empty purpose");
  }
  return errors;
}

export function invalidEntries(sections) {
  return allEntries(sections)
    .map((entry) => ({ entry, errors: entryErrors(entry) }))
    .filter(({ errors }) => errors.length > 0);
}

export function duplicateNames(entries) {
  const counts = new Map();
  for (const { name } of entries) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

function formFiles(root) {
  const dir = join(root, ISSUE_TEMPLATE_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter(
    (file) => file.endsWith(".yml") && file !== CONFIG_FILE
  );
}

export function issueFormLabels(root = ".") {
  const refs = [];
  for (const file of formFiles(root)) {
    const form = parse(
      readFileSync(join(root, ISSUE_TEMPLATE_DIR, file), "utf8")
    );
    const labels = Array.isArray(form?.labels) ? form.labels : [];
    for (const label of labels) {
      refs.push({
        source: `${ISSUE_TEMPLATE_DIR}/${file}`,
        label: String(label),
      });
    }
  }
  return refs;
}

// PR templates carry no first-class label field; an optional
// `<!-- labels: a, b -->` directive lets one declare applied labels explicitly.
export function prTemplateLabels(root = ".") {
  const path = join(root, PR_TEMPLATE_PATH);
  if (!existsSync(path)) {
    return [];
  }
  const match = readFileSync(path, "utf8").match(PR_LABELS_DIRECTIVE);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
    .map((label) => ({ source: PR_TEMPLATE_PATH, label }));
}

export function collectLabelReferences(root = ".") {
  return [...issueFormLabels(root), ...prTemplateLabels(root)];
}

export function unknownReferences(refs, names) {
  const known = new Set(names);
  return refs.filter((ref) => !known.has(ref.label));
}

// True when a referencing doc contains a markdown link that resolves to the
// taxonomy file (VAL-GOV-019).
export function taxonomyLinkResolves(file, root = ".") {
  const path = join(root, file);
  if (!existsSync(path)) {
    return false;
  }
  const text = readFileSync(path, "utf8");
  for (const link of text.matchAll(MARKDOWN_LINK)) {
    const target = link[1].split("#")[0].replace(LEADING_DOT_SLASH, "");
    if (
      target.endsWith("label-taxonomy.md") &&
      existsSync(join(root, target))
    ) {
      return true;
    }
  }
  return false;
}

export function isReferenced(root = ".") {
  return REFERENCING_DOCS.some((file) => taxonomyLinkResolves(file, root));
}

// Lines that assert remote label creation without a deferral marker
// (VAL-GOV-023). Each entry is `line-number: text`.
export function completionClaims(text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, no: index + 1 }))
    .filter(
      ({ line }) => COMPLETION_TERM.test(line) && !DEFERRAL_MARKER.test(line)
    )
    .map(({ line, no }) => `${no}: ${line.trim()}`);
}

// True when the doc explicitly states remote creation is deferred/external.
export function statesRemoteDeferral(text) {
  return text
    .split("\n")
    .some((line) => REMOTE_MENTION.test(line) && DEFERRAL_MARKER.test(line));
}
