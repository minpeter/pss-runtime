import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { diffDrift, findDivergences } from "./workspace-version-drift.mjs";

const manifest = (path) => JSON.parse(readFileSync(path, "utf8"));
const dependency = "@earendil-works/pi-tui";

describe("pi-tui workspace compatibility", () => {
  it("aligns the extension peers with the installed coding-agent range", () => {
    const range = manifest("apps/coding-agent/package.json").dependencies[
      dependency
    ];
    expect(range).toBe("^0.85.0");
    expect(manifest("package.json").devDependencies[dependency]).toBe(range);
    for (const extension of ["latex", "mermaid"]) {
      expect(
        manifest(`extensions/${extension}/package.json`).peerDependencies[
          dependency
        ]
      ).toBe(range);
    }
    const lock = parse(readFileSync("pnpm-lock.yaml", "utf8"));
    for (const [path, field] of [
      [".", "devDependencies"],
      ["apps/coding-agent", "dependencies"],
    ]) {
      expect(lock.importers[path][field][dependency]).toEqual({
        specifier: range,
        version: "0.85.0",
      });
    }
  });

  it("needs no pi-tui drift exemption and detects incompatible peer regressions", () => {
    const baseline = manifest("scripts/workspace-version-drift-baseline.json");
    expect(
      baseline.signatures.some((signature) =>
        signature.startsWith(`${dependency}:`)
      )
    ).toBe(false);
    expect(
      diffDrift(findDivergences(process.cwd()), baseline.signatures)
    ).toEqual({ unbaselined: [], stale: [] });
    const regression = { signature: `${dependency}: ^0.82.1 ^0.85.0` };
    expect(diffDrift([regression], baseline.signatures).unbaselined).toEqual([
      regression,
    ]);
  });
});
