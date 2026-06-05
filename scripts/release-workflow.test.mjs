import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("publishes the v0.1 release lane with the next dist tag", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(packageJson.scripts["release:next"]).toBe(
      "pnpm build && changeset publish --tag next"
    );
    expect(workflow).toContain("      - main\n      - v0.1");
    expect(workflow).toContain("if: github.ref_name == 'main'");
    expect(workflow).toContain("publish: pnpm release\n");
    expect(workflow).toContain("if: github.ref_name == 'v0.1'");
    expect(workflow).toContain("publish: pnpm release:next\n");
  });
});
