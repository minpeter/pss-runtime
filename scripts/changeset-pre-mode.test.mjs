import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("changeset prerelease mode", () => {
  it("keeps the v0.1 branch in next prerelease mode", () => {
    const preState = JSON.parse(readFileSync(".changeset/pre.json", "utf8"));
    const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));

    expect(preState.mode).toBe("pre");
    expect(preState.tag).toBe("next");
    expect(config.baseBranch).toBe("v0.1");
  });

  it("ignores private example packages for release status", () => {
    const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));

    expect(config.ignore).toEqual([
      "@minpeter/pss-example-basic",
      "@minpeter/pss-example-plugin",
      "@minpeter/pss-example-sync-subagent",
      "@minpeter/pss-example-background-subagent",
    ]);
  });
});
