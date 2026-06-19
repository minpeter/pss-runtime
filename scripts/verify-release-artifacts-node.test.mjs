import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  createFixture,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

function nodeDeclarationPath(cwd) {
  return join(
    cwd,
    "packages",
    "runtime",
    "dist",
    "platform",
    "node",
    "index.d.ts"
  );
}

describe("verifyReleaseArtifacts node declaration checks", () => {
  it("requires the runtime node declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(nodeDeclarationPath(cwd));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/node/index.d.ts: missing node runtime declaration",
    ]);
  });

  it("checks Node local helpers on the node declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(nodeDeclarationPath(cwd), "export {};\n");

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export FileSessionStore",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export FileThreadStore",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeFileThreadHostOptions",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export createNodeFileThreadHost",
    ]);
  });
});
