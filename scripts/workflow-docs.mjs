import { parse as parseYaml } from "yaml";

// Shared workflow YAML parsing for the CI invariant modules
// (preserve-workflows.mjs, report-hygiene.mjs): one parse loop and one error
// shape, so every consumer walks the same parsed documents. Parse failures
// are appended to the caller's problems list and the file is skipped.

export function parseWorkflowDocs(workflows, problems) {
  const docs = [];
  for (const { path, source } of workflows) {
    try {
      docs.push({ path, doc: parseYaml(source) });
    } catch (error) {
      problems.push(`${path} parse error: ${error.message}`);
    }
  }
  return docs;
}
