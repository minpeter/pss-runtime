// Bounded, full-consumption parser for the committed Gitleaks TOML subset.
// Unsupported syntax fails closed; description text is never parsed as fields.
export const GITLEAKS_CONFIG_PATH = ".gitleaks.toml";
const CATCH_ALL = /^\^?\s*\.\s*[*+]\s*\$?$/;
// Only the reviewed ellipsis assignment may suppress findings globally.
// A literal word in an arbitrary regex does not bound what it can match.
const PLACEHOLDER_REGEX = String.raw`^[A-Z0-9_]+(API_KEY|TOKEN|SECRET)=\.\.\.$`;
const EXACT_VALUE = /^\^[A-Za-z0-9_]+\$$/;
const EXACT_PATH = /^\^(?:[A-Za-z0-9_/-]|\\[.-])+\$$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const TOKEN =
  /\s+|#[^\r\n]*|\[\[rules\.allowlists\]\]|\[\[rules\]\]|\[extend\]|\[allowlist\]|'''[^']*'''|"[^"\\\r\n]*"|[A-Za-z][A-Za-z0-9]*|[=[\],]/y;
const SPACE = /^\s/;
const FIELD_NAMES = {
  root: ["title"],
  "[extend]": ["useDefault"],
  "[allowlist]": ["description", "paths", "regexes", "regexTarget"],
  "[[rules]]": ["id"],
  "[[rules.allowlists]]": [
    "description",
    "condition",
    "commits",
    "paths",
    "regexTarget",
    "regexes",
  ],
};

function tokenize(source) {
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    TOKEN.lastIndex = cursor;
    const match = TOKEN.exec(source);
    if (!match) {
      throw new Error("unsupported TOML syntax");
    }
    const token = match[0];
    cursor = TOKEN.lastIndex;
    if (!(SPACE.test(token) || token.startsWith("#"))) {
      tokens.push(token);
    }
  }
  return tokens;
}

function scalar(token) {
  if (token?.startsWith("'''")) {
    return token.slice(3, -3);
  }
  if (token?.startsWith('"')) {
    return token.slice(1, -1);
  }
  if (token === "true" || token === "false") {
    return token === "true";
  }
  throw new Error("unsupported TOML value");
}

function parseConfig(source) {
  const tokens = tokenize(source);
  const sections = [{ name: "root", fields: {} }];
  let current = sections[0];
  let index = 0;
  function value() {
    const token = tokens[index++];
    if (token !== "[") {
      return scalar(token);
    }
    const values = [];
    while (tokens[index] !== "]") {
      values.push(scalar(tokens[index++]));
      if (tokens[index] !== ",") {
        break;
      }
      index++;
    }
    if (tokens[index++] !== "]") {
      throw new Error("unterminated or unsupported TOML array");
    }
    return values;
  }
  while (index < tokens.length) {
    const key = tokens[index++];
    if (Object.hasOwn(FIELD_NAMES, key) && key !== "root") {
      current = { name: key, fields: {} };
      sections.push(current);
      continue;
    }
    if (
      !FIELD_NAMES[current.name].includes(key) ||
      Object.hasOwn(current.fields, key)
    ) {
      throw new Error("unexpected or duplicate TOML field or section");
    }
    if (tokens[index++] !== "=") {
      throw new Error("expected TOML assignment");
    }
    current.fields[key] = value();
  }
  return sections;
}

function strings(value) {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function historicalProblems(fields) {
  const problems = [];
  if (
    Object.keys(fields).length !== FIELD_NAMES["[[rules.allowlists]]"].length ||
    typeof fields.description !== "string"
  ) {
    problems.push("historical allowlist requires all supported fields");
  }
  if (fields.condition !== "AND" || fields.regexTarget !== "secret") {
    problems.push(
      "historical allowlist requires AND and extracted-value matching"
    );
  }
  if (
    !strings(fields.commits) ||
    fields.commits.length !== 1 ||
    !FULL_COMMIT.test(fields.commits[0])
  ) {
    problems.push("historical allowlist requires one full commit SHA");
  }
  if (
    !strings(fields.paths) ||
    fields.paths.length !== 1 ||
    !EXACT_PATH.test(fields.paths[0])
  ) {
    problems.push("historical allowlist requires one exact anchored path");
  }
  if (
    !strings(fields.regexes) ||
    fields.regexes.length === 0 ||
    fields.regexes.some((entry) => !EXACT_VALUE.test(entry))
  ) {
    problems.push(
      "historical allowlist requires exact anchored literal values"
    );
  }
  return problems;
}

function sectionProblems(sections) {
  const problems = [];
  let rule;
  let allowlists = 0;
  for (const section of sections) {
    if (section.name === "[[rules]]") {
      if (rule && allowlists === 0) {
        problems.push("historical rule has no reviewed allowlist");
      }
      rule = section.fields.id;
      allowlists = 0;
      if (!["generic-api-key", "cloudflare-api-key"].includes(rule)) {
        problems.push(
          "historical rule must only extend an approved default rule id"
        );
      }
    } else if (section.name === "[[rules.allowlists]]") {
      if (!rule) {
        problems.push("historical allowlist requires a preceding rule");
      }
      allowlists++;
      problems.push(...historicalProblems(section.fields));
    } else if (rule) {
      problems.push("unexpected section after historical rules");
    }
  }
  if (rule && allowlists === 0) {
    problems.push("historical rule has no reviewed allowlist");
  }
  return problems;
}

function regexProblems(regexes) {
  return regexes.flatMap((regex) => {
    if (CATCH_ALL.test(regex)) {
      return [`allowlist regex "${regex}" is a catch-all suppression`];
    }
    if (regex !== PLACEHOLDER_REGEX) {
      return [
        `allowlist regex "${regex}" is not the reviewed placeholder pattern; broad suppressions are not allowed`,
      ];
    }
    return [];
  });
}

export function gitleaksConfigProblems(source) {
  let sections;
  try {
    sections = parseConfig(source);
  } catch (error) {
    return [`${GITLEAKS_CONFIG_PATH}: ${error.message}`];
  }
  const problems = sectionProblems(sections);
  const extensions = sections.filter(({ name }) => name === "[extend]");
  if (extensions.length !== 1 || extensions[0].fields.useDefault !== true) {
    problems.push("config must extend default rules with useDefault = true");
  }
  const globals = sections.filter(({ name }) => name === "[allowlist]");
  if (globals.length !== 1) {
    problems.push("config must declare exactly one [allowlist] block");
    return problems;
  }
  const { paths, regexes } = globals[0].fields;
  if (paths !== undefined) {
    problems.push("global allowlist must not suppress whole files");
  }
  if (!strings(regexes) || regexes.length !== 1) {
    problems.push("allowlist must declare exactly one placeholder regex");
  } else {
    problems.push(...regexProblems(regexes));
  }
  if (globals[0].fields.regexTarget !== "line") {
    problems.push("global placeholder regex must target complete lines");
  }
  return problems;
}
