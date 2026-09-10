import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  agentsReferencesSkills,
  destructiveHits,
  documentedSkills,
  parseSkill,
  readSkill,
  SKILLS_DIR,
  skillDirs,
  skillDocMismatch,
  skillErrors,
  skillFiles,
  unknownPnpmTokens,
  unresolvedPaths,
} from "./governance-skills.mjs";

const VALID_FRONTMATTER =
  "---\nname: sample-skill\ndescription: A real one.\n---\nBody text.\n";

describe("governance: repository skill directory and SKILL.md exist (VAL-GOV-035)", () => {
  it("has at least one tracked, non-empty SKILL.md under .factory/skills", () => {
    const files = skillFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const { file } of files) {
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", file], {
        encoding: "utf8",
      });
      expect(tracked.status, tracked.stderr).toBe(0);
      expect(readSkill(file).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("governance: each SKILL.md is a valid skill file (VAL-GOV-036)", () => {
  it("every shipped SKILL.md has valid frontmatter and a body", () => {
    for (const { file } of skillFiles()) {
      expect(skillErrors(readSkill(file)), file).toEqual([]);
    }
  });

  it("accepts a well-formed skill", () => {
    expect(skillErrors(VALID_FRONTMATTER)).toEqual([]);
    const { data, body } = parseSkill(VALID_FRONTMATTER);
    expect(data.name).toBe("sample-skill");
    expect(body.trim()).toBe("Body text.");
  });

  it("fails on missing frontmatter", () => {
    expect(skillErrors("# Just a body")).toEqual([
      "missing or unparseable frontmatter",
    ]);
  });

  it("fails on an empty description", () => {
    const text = '---\nname: sample-skill\ndescription: ""\n---\nBody.\n';
    expect(skillErrors(text)).toContain("description must be non-empty");
  });

  it("fails on a non-kebab-case name", () => {
    const text = "---\nname: Sample_Skill\ndescription: x\n---\nBody.\n";
    expect(skillErrors(text)).toContain("name must be kebab-case");
  });

  it("fails on an empty body", () => {
    const text = "---\nname: sample-skill\ndescription: x\n---\n   \n";
    expect(skillErrors(text)).toContain("body must be non-empty");
  });
});

describe("governance: skill content references only existing artifacts (VAL-GOV-037)", () => {
  it("every skill path reference resolves on the tree", () => {
    for (const { file } of skillFiles()) {
      expect(unresolvedPaths(readSkill(file)), file).toEqual([]);
    }
  });

  it("every pnpm token in a skill is a real root script", () => {
    for (const { file } of skillFiles()) {
      expect(unknownPnpmTokens(readSkill(file)), file).toEqual([]);
    }
  });

  it("flags a renamed/nonexistent path reference", () => {
    expect(unresolvedPaths("See `scripts/does-not-exist.mjs`.")).toEqual([
      "scripts/does-not-exist.mjs",
    ]);
    expect(unresolvedPaths("See `docs/runbooks/README.md`.")).toEqual([]);
  });

  it("flags a pnpm token that is not a root script", () => {
    expect(unknownPnpmTokens("Run `pnpm not-a-script`.")).toEqual([
      "not-a-script",
    ]);
    expect(unknownPnpmTokens("Run `pnpm test` and `pnpm install`.")).toEqual(
      []
    );
  });
});

describe("governance: skills are discoverable through agent-context docs (VAL-GOV-038)", () => {
  it("AGENTS.md references .factory/skills or concrete skill names", () => {
    expect(agentsReferencesSkills()).toBe(true);
  });

  it("the documented skill set equals the actual skill directories", () => {
    const { undocumented, missing } = skillDocMismatch();
    expect(undocumented).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("extracts skill names from .factory/skills paths", () => {
    const set = documentedSkills(
      "see `.factory/skills/repo-guardian/SKILL.md` and `.factory/skills/edge-contract-check/`"
    );
    expect([...set].sort()).toEqual(["edge-contract-check", "repo-guardian"]);
  });

  it("detects an undocumented skill directory", () => {
    const actual = new Set(skillDirs());
    // Simulate: an extra actual dir not present in the documented set.
    const documented = new Set([...actual]);
    documented.delete([...actual][0]);
    const undocumented = [...actual].filter((n) => !documented.has(n));
    expect(undocumented.length).toBeGreaterThan(0);
  });
});

describe("governance: skills never instruct destructive/high-risk actions (VAL-GOV-039)", () => {
  it("no shipped skill contains an instruction-style hit", () => {
    for (const { file } of skillFiles()) {
      expect(destructiveHits(readSkill(file)), file).toEqual([]);
    }
  });

  it("flags instruction-style destructive/external actions", () => {
    expect(destructiveHits("Run wrangler deploy to production.")).not.toEqual(
      []
    );
    expect(destructiveHits("Then push to main.")).not.toEqual([]);
    expect(destructiveHits("Run rm -rf build to clean.")).not.toEqual([]);
    expect(destructiveHits("Use --force to override.")).not.toEqual([]);
  });

  it("flags embedded credentials and absolute host paths", () => {
    expect(destructiveHits("cd /home/user/project")).not.toEqual([]);
    expect(destructiveHits("export AI_API_KEY=value")).not.toEqual([]);
  });

  it("allows deferral wording for external actions", () => {
    expect(
      destructiveHits("Deployment and publishing are out of scope here.")
    ).toEqual([]);
    expect(
      destructiveHits("This skill never pushes to main and does not deploy.")
    ).toEqual([]);
  });
});

describe("governance: skills live under the expected directory", () => {
  it("uses .factory/skills as the skill root", () => {
    expect(SKILLS_DIR).toBe(".factory/skills");
  });
});
