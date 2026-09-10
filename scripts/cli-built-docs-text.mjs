// Document-text facets for the built-CLI documentation agreement
// (VAL-CROSS-009/010). Split from scripts/cli-built-docs.mjs to stay under
// the 250 pure-LOC ceiling: this module owns the per-document wording
// checks; the sibling owns the package/bin/router/baseline/git checks.

export const CLI_BIN = "apps/coding-agent/bin/pss.js";
export const BUILT_PROBE = `node ${CLI_BIN} --help`;
export const EXEC_OPTION_ERROR_MESSAGE = "Invalid pss exec option.";

// READMEs carry the full error contract and boundary; agent guidance
// carries the built path and the build-before-probe ordering.
export const README_DOCS = ["README.md", "apps/coding-agent/README.md"];
export const GUIDANCE_DOCS = ["apps/coding-agent/AGENTS.md"];

const SOURCE_SHIM_PROBE = /\bnode\s+apps\/coding-agent\/src\//;
const BUILD_FIRST =
  /pnpm build`?\s+first|after `pnpm build`|build[^\n.]*\bprecede/i;
const BOUNDARY_CREDENTIAL = /no (?:provider )?credential/i;
const BOUNDARY_PORT = /no listening port/i;
const CLOSED_LOOP = /closed-loop/i;
const EXIT_ONE = /exits? 1\b/;

// One document's agreement with the built-CLI validation contract.
export function cliDocProblems(doc, text, { full }) {
  const problems = [];
  if (typeof text !== "string") {
    return [`${doc} is missing`];
  }
  if (!text.includes(CLI_BIN)) {
    problems.push(`${doc} does not identify the built CLI path ${CLI_BIN}`);
  }
  if (!text.includes(BUILT_PROBE)) {
    problems.push(
      `${doc} does not document the built probe \`${BUILT_PROBE}\``
    );
  }
  if (!BUILD_FIRST.test(text)) {
    problems.push(
      `${doc} does not state that pnpm build precedes the built CLI probes`
    );
  }
  if (SOURCE_SHIM_PROBE.test(text)) {
    problems.push(
      `${doc} validates the CLI through a source path, not built output`
    );
  }
  if (!full) {
    return problems;
  }
  if (!text.includes("pss exec --help")) {
    problems.push(
      `${doc} does not document the \`pss exec --help\` entrypoint`
    );
  }
  if (!text.includes(EXEC_OPTION_ERROR_MESSAGE)) {
    problems.push(
      `${doc} does not document the bounded exec error "${EXEC_OPTION_ERROR_MESSAGE}"`
    );
  }
  if (!EXIT_ONE.test(text)) {
    problems.push(`${doc} does not document the exit-1 error contract`);
  }
  if (!CLOSED_LOOP.test(text)) {
    problems.push(
      `${doc} does not document the closed-loop validation boundary`
    );
  }
  if (!(BOUNDARY_CREDENTIAL.test(text) && BOUNDARY_PORT.test(text))) {
    problems.push(
      `${doc} does not document the no-credential, no-listening-port boundary`
    );
  }
  return problems;
}
