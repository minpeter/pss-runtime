import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENTS_FILE,
  childGuidanceRefs,
  citedPaths,
  envKnobs,
  FORBIDDEN_STRINGS,
  forbiddenHits,
  governanceScanFiles,
  isTracked,
  knobTraceFiles,
  MIN_SUBSTANTIVE_LINES,
  missingPaths,
  readAgents,
  structurePaths,
  stubViolations,
  trackedAgentsFiles,
  untracedKnobs,
} from "./governance-agents.mjs";

const SKIP_PATTERN = /\b(?:describe|it|test)\.skip\b/;
const ENV_GATE_PATTERN = /\bprocess\.env\b/;

// Load the tracked root AGENTS.md. Both assertions are named failures: the
// file is resolved from git-tracked state, so an untracked shadow copy or a
// deleted working-tree file can never turn these checks into a silent skip.
function trackedRootAgents() {
  const tracked = trackedAgentsFiles();
  expect(tracked, "git ls-files must list AGENTS.md").toContain(AGENTS_FILE);
  expect(
    existsSync(AGENTS_FILE),
    "tracked AGENTS.md is missing from the working tree"
  ).toBe(true);
  return readAgents();
}

describe("governance: root AGENTS.md is tracked and resolved via git (VAL-GOV-045)", () => {
  it("git ls-files lists AGENTS.md even though .gitignore ignores it", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    expect(gitignore).toContain("AGENTS.md");
    expect(trackedAgentsFiles()).toContain(AGENTS_FILE);
  });

  it("resolves the tracked file from the working tree", () => {
    expect(trackedRootAgents().trim().length).toBeGreaterThan(0);
  });

  it("keeps every referenced child guidance file git-tracked", () => {
    for (const ref of childGuidanceRefs(trackedRootAgents())) {
      expect(isTracked(ref), `${ref} must survive a fresh checkout`).toBe(true);
    }
  });
});

describe("governance: structure block matches the actual repository layout (VAL-GOV-040)", () => {
  it("every path named in the structure block exists", () => {
    const paths = structurePaths(trackedRootAgents());
    expect(paths.length).toBeGreaterThan(0);
    expect(missingPaths(paths)).toEqual([]);
  });

  it("parses tree glyphs and expands brace groups", () => {
    const text = [
      "## STRUCTURE",
      "",
      "```",
      "repo/",
      "├── packages/runtime/  # comment",
      "├── extensions/{a,b}/  # comment",
      "└── docs/",
      "```",
    ].join("\n");
    expect(structurePaths(text)).toEqual([
      "packages/runtime/",
      "extensions/a/",
      "extensions/b/",
      "docs/",
    ]);
  });

  it("flags a phantom directory entry", () => {
    expect(missingPaths(["phantom-missing-dir/"])).toEqual([
      "phantom-missing-dir/",
    ]);
    expect(missingPaths(["packages/"])).toEqual([]);
  });
});

describe("governance: child-guidance references resolve to real files (VAL-GOV-041)", () => {
  it("every child-guidance reference resolves to a non-stub file", () => {
    const refs = childGuidanceRefs(trackedRootAgents());
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(ref), `${ref} does not exist`).toBe(true);
      expect(
        stubViolations(readFileSync(ref, "utf8")),
        `${ref} is a stub`
      ).toEqual([]);
    }
  });

  it("extracts references from wrapped bullets, table rows, and direct paths", () => {
    const text = [
      "Deeper guidance lives in child AGENTS.md files (`packages/runtime`,",
      "  `examples`) - read the child.",
      "",
      "| Engine | `packages/runtime/src/thread/runtime/` | see its AGENTS.md |",
      "| Other | `apps/coding-agent/` | no mention here |",
      "",
      "See `scripts/AGENTS.md` for details.",
    ].join("\n");
    expect(childGuidanceRefs(text)).toEqual([
      "examples/AGENTS.md",
      "packages/runtime/AGENTS.md",
      "packages/runtime/src/thread/runtime/AGENTS.md",
      "scripts/AGENTS.md",
    ]);
  });

  it("rejects zero-byte, whitespace-only, and placeholder-only targets", () => {
    expect(stubViolations("")).toEqual(["target is zero bytes"]);
    expect(stubViolations("  \n\n \t\n")).toEqual([
      "target is whitespace-only",
    ]);
    expect(stubViolations("# Title\n\nTBD\n")).toEqual([
      `target has 1 substantive lines (< ${MIN_SUBSTANTIVE_LINES})`,
    ]);
    expect(stubViolations("# Title\n\n- TODO\n- FIXME\n")).not.toEqual([]);
    expect(
      stubViolations("# Guide\n\nReal line one.\nReal line two.\n")
    ).toEqual([]);
  });

  it("flags a dangling reference to a nonexistent child AGENTS.md", () => {
    expect(existsSync("packages/definitely-not-here/AGENTS.md")).toBe(false);
  });
});

describe("governance: AGENTS.md self-citations resolve (VAL-GOV-042)", () => {
  it("every repo path AGENTS.md cites as an artifact or enforcer exists", () => {
    const cited = citedPaths(trackedRootAgents());
    expect(cited.length).toBeGreaterThan(0);
    expect(missingPaths(cited)).toEqual([]);
  });

  it("flags an anchored path that was renamed or removed", () => {
    expect(missingPaths(citedPaths("See `scripts/renamed-away.mjs`."))).toEqual(
      ["scripts/renamed-away.mjs"]
    );
    expect(missingPaths(citedPaths("See `packages/extension-api`."))).toEqual([
      "packages/extension-api",
    ]);
  });

  it("ignores shorthand tokens that are not root-relative citations", () => {
    expect(citedPaths("Run built `bin/pss.js`; no `index.ts` here.")).toEqual(
      []
    );
    expect(citedPaths("Notes in `tui/app.ts` stay shorthand.")).toEqual([]);
  });

  it("accepts a real citation", () => {
    expect(
      missingPaths(citedPaths("Asserted by `scripts/runtime-docs.test.mjs`."))
    ).toEqual([]);
  });
});

describe("governance: forbidden anti-patterns stay out of agent-context docs (VAL-GOV-043)", () => {
  it("scans every tracked AGENTS.md, governance doc, and runbook", () => {
    const files = governanceScanFiles();
    expect(files).toContain(AGENTS_FILE);
    expect(files).toContain("SECURITY.md");
    expect(files.some((file) => file.startsWith("docs/runbooks/"))).toBe(true);
    for (const file of files) {
      expect(forbiddenHits(readFileSync(file, "utf8")), file).toEqual([]);
    }
  });

  it("detects every forbidden string", () => {
    for (const bad of FORBIDDEN_STRINGS) {
      expect(forbiddenHits(`docs show ${bad} here`)).toEqual([`1: ${bad}`]);
    }
    expect(
      forbiddenHits("createAgent and agent.thread are the surface")
    ).toEqual([]);
  });
});

describe("governance: documented env knobs appear in the repository (VAL-GOV-044)", () => {
  it("every documented knob has a non-AGENTS.md repository trace", () => {
    const text = trackedRootAgents();
    expect(envKnobs(text).length).toBeGreaterThan(0);
    expect(untracedKnobs(text)).toEqual([]);
  });

  it("parses knob tokens and expands wildcards to their prefix", () => {
    expect(envKnobs("knobs: `PSS_LATEX*`, `PSS_MERMAID`.")).toEqual([
      "PSS_LATEX",
      "PSS_MERMAID",
    ]);
  });

  it("flags a knob with no repository trace", () => {
    // Built at runtime so this test file is not itself a trace of the knob.
    const fakeKnob = ["PSS", "DEFINITELY", "NOT", "REAL", "99"].join("_");
    expect(knobTraceFiles(fakeKnob)).toEqual([]);
    expect(untracedKnobs(`set \`${fakeKnob}\` first`)).toEqual([fakeKnob]);
  });

  it("never counts AGENTS.md files as a trace", () => {
    const traces = knobTraceFiles("PSS_THREAD_DIR");
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((file) => !file.endsWith("AGENTS.md"))).toBe(true);
  });
});

describe("governance: the AGENTS validator never fails silently (VAL-GOV-046)", () => {
  it("contains no skip path for its critical checks", () => {
    for (const file of [
      "scripts/governance-agents.mjs",
      "scripts/governance-agents.test.mjs",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(SKIP_PATTERN.test(source), file).toBe(false);
      expect(ENV_GATE_PATTERN.test(source), file).toBe(false);
    }
  });
});
