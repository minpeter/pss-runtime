// Security-workflow runbook invariants (VAL-SEC-039): each security workflow
// (CodeQL, gitleaks, OWASP ZAP) has a runbook entry under docs/runbooks/
// documenting the trigger, the expected output, the failure triage path, and
// the safe behavior when the tool is unavailable or finds issues. Static over
// committed files only: no network, no ports, no writes, no clock.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  RUNBOOKS_DIR,
  readRunbook,
  runbookMarkdownFiles,
} from "./governance-runbooks.mjs";

// The committed security workflows and the name a runbook entry uses for
// each tool. The workflow file itself must exist for the entry to count.
export const SECURITY_WORKFLOWS = [
  { file: "codeql.yml", tool: /codeql/i, label: "CodeQL" },
  { file: "gitleaks.yml", tool: /gitleaks/i, label: "gitleaks" },
  { file: "zap.yml", tool: /owasp zap|\bzap\b/i, label: "OWASP ZAP" },
];

const WORKFLOWS_DIR = ".github/workflows";

// Every runbook entry must document these four aspects.
export const REQUIRED_ASPECTS = [
  {
    key: "trigger",
    pattern:
      /\btrigger|runs on|workflow_dispatch|schedule|push to|pull request|manual dispatch/i,
  },
  {
    key: "expected output",
    pattern: /\boutput|step log|run summary|finding|report|artifact|alert/i,
  },
  {
    key: "failure triage",
    pattern: /\btriage|false positive|re-run|rotate|fix|recovery/i,
  },
  {
    key: "unavailable-tool behavior",
    pattern:
      /\bunavailable|not installed|absent|outage|unreachable|external|cannot be verified|deferred/i,
  },
];

const HEADING = /^#{1,6}\s/;

// Split a markdown document into { heading, body } sections, keeping the
// heading line with its body so a section can be matched by title or prose.
export function markdownSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (HEADING.test(line)) {
      current = { heading: line, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections.map(({ heading, body }) => `${heading}\n${body.join("\n")}`);
}

// The combined text of every runbook section that mentions the tool.
export function runbookEntry(files, tool) {
  const entries = [];
  for (const { name, text } of files) {
    for (const section of markdownSections(text)) {
      if (tool.test(section)) {
        entries.push(`${name}: ${section}`);
      }
    }
  }
  return entries.join("\n");
}

export function readRunbookFiles(root = ".") {
  return runbookMarkdownFiles(root).map((name) => ({
    name,
    text: readRunbook(name, root),
  }));
}

// Per-workflow problems: a missing entry, or an entry missing an aspect.
export function runbookProblems(files, workflows = SECURITY_WORKFLOWS) {
  const problems = [];
  for (const { file, tool, label } of workflows) {
    if (!existsSync(join(WORKFLOWS_DIR, file))) {
      problems.push(`security workflow ${file} is missing from the tree`);
      continue;
    }
    const entry = runbookEntry(files, tool);
    if (entry.trim() === "") {
      problems.push(
        `no runbook entry under ${RUNBOOKS_DIR}/ covers the ${label} workflow (${file})`
      );
      continue;
    }
    for (const { key, pattern } of REQUIRED_ASPECTS) {
      if (!pattern.test(entry)) {
        problems.push(
          `runbook entry for ${label} (${file}) lacks ${key} coverage`
        );
      }
    }
  }
  return problems;
}
