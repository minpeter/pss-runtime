import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CI_RUNBOOK_FILE,
  ciGateScripts,
  citedJobSteps,
  danglingRunbookLinks,
  INDEX_FILE,
  nonMarkdownFiles,
  offLimitsPortHits,
  orphanRunbooks,
  parseWorkflows,
  productionClaimHits,
  productionMutationHits,
  RUNBOOKS_DIR,
  readIndex,
  readRunbook,
  runbookLinkTargets,
  runbookMarkdownFiles,
  secretValueHits,
  unknownSecretNames,
  unmappedTopics,
  unresolvedJobSteps,
  unresolvedLinks,
  unresolvedWorkflowFiles,
  unsupportedGateClaims,
  usesBareDevCommand,
  usesDevRelay,
  workerHealthLocalBoundary,
} from "./governance-runbooks.mjs";

const SECURITY_TOPIC_LINE = /^.*security[- ]scan.*$/im;

function allRunbookText() {
  return [INDEX_FILE, ...runbookMarkdownFiles()]
    .map((file) => readRunbook(file))
    .join("\n");
}

describe("governance: runbook directory, index, and links (VAL-GOV-029)", () => {
  it("tracks the runbook index in git", () => {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", `${RUNBOOKS_DIR}/${INDEX_FILE}`],
      { encoding: "utf8" }
    );
    expect(tracked.status, tracked.stderr).toBe(0);
  });

  it("contains only markdown files", () => {
    expect(nonMarkdownFiles()).toEqual([]);
  });

  it("links exactly the runbook file set with no orphans or dangling links", () => {
    const index = readIndex();
    expect(orphanRunbooks(index)).toEqual([]);
    expect(danglingRunbookLinks(index)).toEqual([]);
    const linked = new Set(runbookLinkTargets(index));
    expect([...linked].sort()).toEqual([...runbookMarkdownFiles()].sort());
  });

  it("resolves every index link on disk", () => {
    expect(unresolvedLinks(readIndex())).toEqual([]);
  });

  it("fails when a runbook is orphaned or a link dangles", () => {
    const files = runbookMarkdownFiles();
    // An index that links only the second runbook orphans the first.
    const partialIndex = `[keep](${files[1]})`;
    expect(orphanRunbooks(partialIndex)).toContain(files[0]);
    // A link to a missing same-dir runbook is dangling.
    expect(danglingRunbookLinks("[x](does-not-exist.md)")).toEqual([
      "does-not-exist.md",
    ]);
    // A dangling relative link is unresolved.
    expect(unresolvedLinks("[x](missing-file.md)").length).toBeGreaterThan(0);
  });
});

describe("governance: runbooks cover the required topics (VAL-GOV-030)", () => {
  it("maps all five required topics to existing runbooks", () => {
    expect(unmappedTopics(readIndex())).toEqual([]);
  });

  it("fails when a required topic loses its runbook link", () => {
    const stripped = readIndex().replace(
      SECURITY_TOPIC_LINE,
      "- (security runbook removed)"
    );
    expect(unmappedTopics(stripped)).toContain("security-scan");
  });
});

describe("governance: runbook workflow/job references resolve (VAL-GOV-031)", () => {
  const text = allRunbookText();

  it("cites only workflow files that exist under .github/workflows", () => {
    expect(unresolvedWorkflowFiles(text)).toEqual([]);
  });

  it("cites only jobs/steps present in the parsed workflow YAML", () => {
    expect(unresolvedJobSteps(text)).toEqual([]);
  });

  it("actually cites at least one workflow job", () => {
    expect(citedJobSteps(text).some((c) => c.kind === "job")).toBe(true);
  });

  it("fails on a citation to a nonexistent job or workflow", () => {
    expect(unresolvedJobSteps("`ci.yml` job `ghost-job`")).toHaveLength(1);
    expect(unresolvedWorkflowFiles("`no-such-workflow.yml`")).toEqual([
      "no-such-workflow.yml",
    ]);
  });

  it("parses real job names from ci.yml", () => {
    expect(parseWorkflows()["ci.yml"].jobs.has("checks")).toBe(true);
  });
});

describe("governance: CI runbook fast-gate claims are a subset (VAL-GOV-032)", () => {
  it("attributes only real ci.yml scripts to the fast gate", () => {
    expect(unsupportedGateClaims(readRunbook(CI_RUNBOOK_FILE))).toEqual([]);
  });

  it("derives the gate script set from ci.yml", () => {
    const scripts = ciGateScripts();
    expect(scripts.has("lint")).toBe(true);
    expect(scripts.has("test")).toBe(true);
    expect(scripts.has("verify:release")).toBe(true);
  });

  it("fails when the runbook claims a script the gate does not run", () => {
    const fake = "## Fast gate steps\n- `pnpm deploy:prod` runs here.\n## Next";
    expect(unsupportedGateClaims(fake)).toEqual(["deploy:prod"]);
  });
});

describe("governance: worker health runbook respects the local boundary (VAL-GOV-033)", () => {
  const runbooks = allRunbookText();

  it("documents runtime build then dev:worker on 127.0.0.1:8792", () => {
    expect(workerHealthLocalBoundary()).toBe(true);
  });

  it("references no off-limits ports anywhere in the runbooks", () => {
    expect(offLimitsPortHits(runbooks)).toEqual([]);
  });

  it("never instructs pnpm dev or dev:relay as a validation command", () => {
    expect(usesBareDevCommand(runbooks)).toBe(false);
    expect(usesDevRelay(runbooks)).toBe(false);
  });

  it("makes no production-monitoring completion claim", () => {
    expect(productionClaimHits(runbooks)).toEqual([]);
  });

  it("detects an injected off-limits port and bare dev command", () => {
    expect(offLimitsPortHits("bind 127.0.0.1:3000 now")).toContain("3000");
    expect(usesBareDevCommand("run pnpm dev to validate")).toBe(true);
    expect(usesDevRelay("start dev:relay")).toBe(true);
    // dev:worker and dev:tui must not trip the bare-dev detector.
    expect(usesBareDevCommand("pnpm dev:worker")).toBe(false);
  });

  it("flags a production claim without a deferral marker", () => {
    expect(
      productionClaimHits("Production monitoring is enabled and live.")
    ).not.toEqual([]);
    expect(
      productionClaimHits("Production monitoring is deferred and external.")
    ).toEqual([]);
  });
});

describe("governance: runbooks are secret-free and locally executable (VAL-GOV-034)", () => {
  const runbooks = allRunbookText();

  it("contains no credential-shaped literals", () => {
    expect(secretValueHits(runbooks)).toEqual([]);
  });

  it("names only the documented placeholder secrets", () => {
    expect(unknownSecretNames(runbooks)).toEqual([]);
  });

  it("contains no production-mutation commands", () => {
    expect(productionMutationHits(runbooks)).toEqual([]);
  });

  it("flags an injected key, unknown secret, or publish command", () => {
    expect(secretValueHits(`token sk-${"a".repeat(24)} here`)).not.toEqual([]);
    expect(unknownSecretNames("export ROGUE_API_KEY=x")).toContain(
      "ROGUE_API_KEY"
    );
    expect(productionMutationHits("run npm publish now")).not.toEqual([]);
    expect(productionMutationHits("wrangler deploy --env prod")).not.toEqual(
      []
    );
  });
});
