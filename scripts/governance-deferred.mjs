import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFERRED_DOC } from "./governance-readme.mjs";

export const RUNBOOK_INDEX = "docs/runbooks/README.md";
export const README_FILE = "README.md";
export const WORKFLOWS_DIR = ".github/workflows";

// Files that must exist and stay tracked for this surface (VAL-GOV-058);
// the wider required-governance-files manifest reuses DEFERRED_DOC from here.
export const REQUIRED_FILES = [DEFERRED_DOC];

// The single authoritative deferred-controls inventory (VAL-GOV-053/054/058).
// `heading` matches the item's `###` section heading; `substitutes` are the
// repo-local counterpart artifacts that must be cited by the item and exist.
export const REQUIRED_ITEMS = [
  {
    key: "branch-protection-enforcement",
    heading: /branch-protection enforcement/i,
    substitutes: [".github/CODEOWNERS"],
  },
  {
    key: "native-secret-scanning",
    heading: /native github secret-scanning settings/i,
    substitutes: ["docs/runbooks/security-scan-failure-triage.md"],
  },
  {
    key: "product-analytics",
    heading: /product analytics/i,
    substitutes: ["docs/worker-agent.md"],
  },
  {
    key: "hosted-error-tracking",
    heading: /hosted error tracking/i,
    substitutes: ["docs/worker-agent.md"],
  },
  {
    key: "hosted-alerting",
    heading: /hosted alerting/i,
    substitutes: ["docs/runbooks/worker-health.md"],
  },
  {
    key: "progressive-rollout",
    heading: /progressive rollout/i,
    substitutes: ["docs/runbooks/release-procedure.md"],
  },
  {
    key: "automated-rollback",
    heading: /automated rollback/i,
    substitutes: ["docs/runbooks/release-procedure.md"],
  },
  {
    key: "remote-label-creation",
    heading: /remote github label creation/i,
    substitutes: ["docs/label-taxonomy.md"],
  },
  {
    key: "codeowners-enforcement",
    heading: /codeowners enforcement/i,
    substitutes: [".github/CODEOWNERS"],
  },
  {
    key: "dependabot-run-activation",
    heading: /dependabot run activation/i,
    substitutes: [".github/dependabot.yml"],
  },
  {
    key: "production-deployment-monitoring",
    heading: /production deployment and health monitoring/i,
    substitutes: ["docs/runbooks/worker-health.md"],
  },
];

// Substitute artifacts a later milestone has not committed yet. A cited path
// may be absent only if it is listed here AND the citing section marks it
// pending (VAL-GOV-055 ordering tolerance). Both security-milestone
// substitute workflows (codeql.yml, gitleaks.yml) exist in the repository
// now, so the list is empty; re-add an entry only while the cited artifact
// is genuinely absent from the tree.
export const PENDING_ARTIFACTS = [];

const ITEM_HEADING = /^###\s+\d+\.\s+(.*\S)\s*$/;
const H2_HEADING = /^##\s/;
const PATH_TOKEN = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)`/g;
const STATUS_MARKER = /status:\s*deferred/i;
const EXTERNAL_ONLY = /external-only/i;
const CANNOT_VERIFY =
  /cannot be verified from repository files or local commands/i;
const PENDING_WORD = /\bpending\b/i;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function readDoc(path, root = ".") {
  return readFileSync(join(root, path), "utf8");
}

// `### N. <title>` sections of the deferred list (VAL-GOV-054/058).
export function itemSections(text) {
  const sections = [];
  const lines = text.split("\n");
  let current = null;
  for (const line of lines) {
    const match = ITEM_HEADING.exec(line);
    if (match) {
      current = { title: match[1], body: "" };
      sections.push(current);
    } else if (current && H2_HEADING.test(line)) {
      current = null;
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return sections;
}

// Required items with no matching section, and sections matching no required
// item (inventory drift in either direction fails VAL-GOV-054/058).
export function inventoryProblems(text) {
  const sections = itemSections(text);
  const problems = [];
  for (const item of REQUIRED_ITEMS) {
    if (!sections.some((section) => item.heading.test(section.title))) {
      problems.push(`missing deferred item: ${item.key}`);
    }
  }
  for (const section of sections) {
    if (!REQUIRED_ITEMS.some((item) => item.heading.test(section.title))) {
      problems.push(`unknown deferred item section: ${section.title}`);
    }
  }
  return problems;
}

// Missing deferred/external-only markers or the cannot-verify statement.
export function markerProblems(text) {
  const problems = [];
  for (const item of REQUIRED_ITEMS) {
    const section = itemSections(text).find((s) => item.heading.test(s.title));
    if (!section) {
      continue;
    }
    if (!STATUS_MARKER.test(section.body)) {
      problems.push(`${item.key}: missing "Status: deferred" marker`);
    }
    if (!EXTERNAL_ONLY.test(section.body)) {
      problems.push(`${item.key}: missing external-only marker`);
    }
    if (!CANNOT_VERIFY.test(section.body)) {
      problems.push(`${item.key}: missing cannot-verify statement`);
    }
  }
  return problems;
}

export function citedPaths(body) {
  return [...new Set([...body.matchAll(PATH_TOKEN)].map((m) => m[1]))];
}

// Substitute mapping problems (VAL-GOV-055): every item cites its declared
// repo-local substitute, the cited substitute exists, and any other cited
// path either exists or is an allowlisted pending artifact marked pending.
function requiredSubstituteProblems(item, cited, root) {
  return item.substitutes.flatMap((required) => {
    if (!cited.includes(required)) {
      return [`${item.key}: substitute ${required} not cited`];
    }
    if (!existsSync(join(root, required))) {
      return [`${item.key}: substitute ${required} missing on disk`];
    }
    return [];
  });
}

function citedArtifactProblems(item, section, cited, root) {
  return cited.flatMap((path) => {
    if (existsSync(join(root, path))) {
      return [];
    }
    if (!PENDING_ARTIFACTS.includes(path)) {
      return [`${item.key}: cited artifact ${path} does not exist`];
    }
    if (!PENDING_WORD.test(section.body)) {
      return [`${item.key}: pending artifact ${path} not marked pending`];
    }
    return [];
  });
}

export function substituteProblems(text, root = ".") {
  const problems = [];
  for (const item of REQUIRED_ITEMS) {
    const section = itemSections(text).find((s) => item.heading.test(s.title));
    if (!section) {
      continue;
    }
    const cited = citedPaths(section.body);
    problems.push(...requiredSubstituteProblems(item, cited, root));
    problems.push(...citedArtifactProblems(item, section, cited, root));
  }
  return problems;
}

// A document links the deferred list when a relative markdown link resolves
// to it (VAL-GOV-053).
export function linksDeferredDoc(docPath, text) {
  const base = docPath.split("/").slice(0, -1);
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const target = match[1].split("#")[0];
    const resolved = [...base, ...target.split("/")]
      .reduce((acc, part) => {
        if (part === "..") {
          acc.pop();
        } else if (part !== "." && part !== "") {
          acc.push(part);
        }
        return acc;
      }, [])
      .join("/");
    if (resolved === DEFERRED_DOC) {
      return true;
    }
  }
  return false;
}
