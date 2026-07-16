import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("versions or publishes main through Tegami", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(packageJson.scripts.tegami).toBe("node scripts/tegami.mts");
    expect(packageJson.scripts.changeset).toBeUndefined();
    expect(packageJson.scripts["version-packages"]).toBeUndefined();
    expect(packageJson.scripts["release:v0.1"]).toBeUndefined();
    expect(packageJson.devDependencies.tegami).toBe("1.2.5");
    expect(packageJson.devDependencies["@changesets/cli"]).toBeUndefined();
    expect(workflow).toContain("      - main\n");
    expect(workflow).not.toContain("      - v0.1\n");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("pnpm tegami ci");
    expect(workflow).toContain('NPM_CONFIG_PROVENANCE: "true"');
    expect(workflow).not.toContain("changesets/action");
  });
});
