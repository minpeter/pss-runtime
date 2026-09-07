import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const ISSUE_TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";

// GitHub issue-form element types. `config.yml` is the chooser config, not a
// form, so it is excluded from the form set.
export const ALLOWED_TYPES = new Set([
  "markdown",
  "input",
  "textarea",
  "dropdown",
  "checkboxes",
]);

const CONFIG_FILE = "config.yml";

// Repo-relative path shapes worth resolving; `@scope/pkg` and bare tokens are
// intentionally excluded so npm package names are not mistaken for file paths.
const PATH_TOKEN =
  /(?:\.\.?\/|(?:packages|apps|extensions|examples|experimental|docs|scripts|script|assets|\.github|\.factory)\/)[A-Za-z0-9._/-]+/g;

const CREDENTIAL_PATTERN =
  /api[\s_-]?key|\btoken\b|\bsecret\b|\bcredential\b|\.env\b|auth header/i;

const TRAILING_PUNCTUATION = /[.,;:)`'"]+$/;

const BUG_NAME_PATTERN = /\bbug\b|defect|crash/;

const FEATURE_NAME_PATTERN = /feature|enhancement|request|proposal/;

export function listFormFiles(gitLsFiles) {
  return gitLsFiles
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".yml"))
    .filter((line) => !line.endsWith(`/${CONFIG_FILE}`))
    .filter((line) => line.startsWith(`${ISSUE_TEMPLATE_DIR}/`));
}

export function parseForm(path) {
  return parse(readFileSync(path, "utf8"));
}

export function frontmatterErrors(form) {
  const errors = [];
  if (typeof form !== "object" || form === null) {
    return ["form is not a mapping"];
  }
  for (const key of ["name", "description"]) {
    if (typeof form[key] !== "string" || form[key].trim().length === 0) {
      errors.push(`missing or empty ${key}`);
    }
  }
  if (!Array.isArray(form.body) || form.body.length === 0) {
    errors.push("body is not a non-empty array");
  }
  return errors;
}

export function bodyElementErrors(form) {
  const errors = [];
  const seenIds = new Set();
  const body = Array.isArray(form?.body) ? form.body : [];
  for (const [index, element] of body.entries()) {
    if (typeof element !== "object" || element === null) {
      errors.push(`element ${index} is not a mapping`);
      continue;
    }
    if (!ALLOWED_TYPES.has(element.type)) {
      errors.push(`element ${index} has unknown type ${String(element.type)}`);
    }
    const isMarkdown = element.type === "markdown";
    if (!isMarkdown) {
      if (typeof element.id !== "string" || element.id.trim().length === 0) {
        errors.push(`element ${index} (${element.type}) is missing an id`);
      } else if (seenIds.has(element.id)) {
        errors.push(`duplicate id ${element.id}`);
      } else {
        seenIds.add(element.id);
      }
      if (
        typeof element.attributes !== "object" ||
        element.attributes === null
      ) {
        errors.push(`element ${index} (${element.type}) is missing attributes`);
      }
    }
  }
  return errors;
}

// Labelled fields are the interactive elements a reporter fills in; markdown
// blurbs carry no label and cannot stand in for a data field.
export function labelledFields(form) {
  const body = Array.isArray(form?.body) ? form.body : [];
  return body
    .filter((element) => element?.type && element.type !== "markdown")
    .map((element) => ({
      type: element.type,
      label: String(element?.attributes?.label ?? ""),
    }));
}

export function hasFieldMatching(form, regex) {
  return labelledFields(form).some((field) => regex.test(field.label));
}

export function collectFormText(form) {
  const chunks = [];
  const walk = (value) => {
    if (typeof value === "string") {
      chunks.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        walk(item);
      }
    }
  };
  walk(form);
  return chunks.join("\n");
}

export function findCredentialSolicitation(text) {
  return text.split("\n").filter((line) => CREDENTIAL_PATTERN.test(line));
}

export function findDanglingPaths(text, repoRoot = ".") {
  const dangling = [];
  for (const raw of text.match(PATH_TOKEN) ?? []) {
    const token = raw.replace(TRAILING_PUNCTUATION, "");
    if (token.endsWith("/") || token.length < 3) {
      continue;
    }
    if (!existsSync(join(repoRoot, token))) {
      dangling.push(token);
    }
  }
  return dangling;
}

export function classifyForm(form) {
  const haystack =
    `${form?.name ?? ""} ${form?.description ?? ""}`.toLowerCase();
  return {
    isBug: BUG_NAME_PATTERN.test(haystack),
    isFeature: FEATURE_NAME_PATTERN.test(haystack),
  };
}
