// Declared auto-fix policy parsing for the pre-commit gate (VAL-LOCAL-005).
// Split from precommit-hook.mjs to stay under the 250 pure-LOC ceiling.

const HEADING_LINE = /^#{1,6}\s+/;
const PRE_COMMIT_HEADING = /pre-commit hook/i;
const POLICY_DECLARATION = /auto-fix mode:\s*(.+)/i;
const VACUOUS_WORDING = /\bif\b|\bmay\b|\boptional\b|when supported/;
const FIX_ON_WRITE = /fix-on-write/;
const ABORT_ONLY = /abort-only/;
const FIX_COMMAND = /\bfix\b|--write/;

export function extractSection(markdown, headingPattern) {
  const lines = markdown.split("\n");
  const start = lines.findIndex(
    (line) => HEADING_LINE.test(line) && headingPattern.test(line)
  );
  if (start === -1) {
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADING_LINE.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function declaredPolicy(contributing) {
  const problems = [];
  const section = extractSection(contributing, PRE_COMMIT_HEADING);
  if (section === null) {
    return { mode: null, problems: ["no pre-commit hook section found"] };
  }
  const declaration = section.match(POLICY_DECLARATION);
  if (!declaration) {
    return { mode: null, problems: ["section declares no 'Auto-fix mode:'"] };
  }
  const line = declaration[1].toLowerCase();
  if (VACUOUS_WORDING.test(line)) {
    problems.push("auto-fix policy is vacuous or conditional");
  }
  const fix = FIX_ON_WRITE.test(line);
  const abort = ABORT_ONLY.test(line);
  if (fix === abort) {
    problems.push("auto-fix policy must name exactly one concrete mode");
  }
  let mode = null;
  if (fix !== abort) {
    mode = fix ? "fix-on-write" : "abort-only";
  }
  return { mode, problems };
}

export function policyConfigProblems(mode, mappings) {
  const usesFix = mappings.some((mapping) =>
    mapping.commands.some((command) => FIX_COMMAND.test(command))
  );
  if (mode === "fix-on-write") {
    return usesFix ? [] : ["declared fix-on-write but no command rewrites"];
  }
  if (mode === "abort-only") {
    return usesFix ? ["declared abort-only but a command rewrites files"] : [];
  }
  return ["no concrete declared mode to compare against the config"];
}
