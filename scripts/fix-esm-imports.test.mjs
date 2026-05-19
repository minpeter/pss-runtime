import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixEsmImports } from "./fix-esm-imports.mjs";

let tempRoots = [];

function createDist() {
  const dist = mkdtempSync(join(tmpdir(), "pss-fix-esm-imports-"));
  tempRoots.push(dist);
  return dist;
}

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots = [];
});

describe("fixEsmImports", () => {
  it("rewrites extensionless static, side-effect, and dynamic imports", () => {
    const dist = createDist();
    writeFileSync(join(dist, "dep.js"), "export default true;\n");
    writeFileSync(join(dist, "side-effect.js"), "globalThis.ok = true;\n");
    writeFileSync(join(dist, "chunk.js"), "export const chunk = true;\n");
    writeFileSync(
      join(dist, "index.js"),
      [
        'import value from "./dep";',
        'import "./side-effect";',
        'export const chunk = () => import("./chunk");',
        'export const kept = () => import("./already.js");',
        "",
      ].join("\n")
    );

    fixEsmImports(dist);

    expect(readFileSync(join(dist, "index.js"), "utf8")).toBe(
      [
        'import value from "./dep.js";',
        'import "./side-effect.js";',
        'export const chunk = () => import("./chunk.js");',
        'export const kept = () => import("./already.js");',
        "",
      ].join("\n")
    );
  });

  it("rewrites trailing-slash directory imports to index.js", () => {
    const dist = createDist();
    mkdirSync(join(dist, "foo"));
    writeFileSync(join(dist, "foo.js"), "export const file = true;\n");
    writeFileSync(join(dist, "foo", "index.js"), "export const dir = true;\n");
    writeFileSync(join(dist, "index.js"), 'import "./foo/";\n');

    fixEsmImports(dist);

    expect(readFileSync(join(dist, "index.js"), "utf8")).toBe(
      'import "./foo/index.js";\n'
    );
  });
});
