import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  createFixture,
} from "./verify-release-artifacts.fixture.mjs";

const malformedWebManifestPattern =
  /^extensions\/web\/package\.json: cannot read package\.json /u;

function removeLicense(manifest) {
  manifest.license = undefined;
}

function removePublicAccess(manifest) {
  manifest.publishConfig.access = undefined;
}

function removeProvenance(manifest) {
  manifest.publishConfig.provenance = undefined;
}

afterEach(cleanupFixtures);

describe("verifyReleaseArtifacts extension package checks", () => {
  it("fails closed when the web extension dist is empty", () => {
    const cwd = createFixture();
    rmSync(resolve(cwd, "extensions/web/dist"), {
      force: true,
      recursive: true,
    });
    mkdirSync(resolve(cwd, "extensions/web/dist"), { recursive: true });

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["extension-web"] })
    ).toEqual([
      "extensions/web/dist/index.js is missing; required extension artifact",
      "extensions/web/dist/index.d.ts is missing; required extension artifact",
    ]);
  });

  it("fails closed when the web extension package manifest is malformed", () => {
    const cwd = createFixture();
    writeFileSync(resolve(cwd, "extensions/web/package.json"), "not json\n");

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["extension-web"] })
    ).toEqual([expect.stringMatching(malformedWebManifestPattern)]);
  });

  it.each([
    ["license", removeLicense],
    ["license file list", (manifest) => manifest.files.pop()],
    ["public access", removePublicAccess],
    ["provenance", removeProvenance],
  ])("fails closed when extension metadata loses %s", (_label, mutate) => {
    const cwd = createFixture();
    const manifestPath = resolve(cwd, "extensions/web/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    mutate(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["extension-web"] })
    ).toContain(
      "extensions/web/package.json: invalid extension package contract"
    );
  });

  it("fails closed when the packaged license file is missing", () => {
    const cwd = createFixture();
    rmSync(resolve(cwd, "extensions/web/LICENSE.md"));

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["extension-web"] })
    ).toContain(
      "extensions/web/LICENSE.md is missing; required extension license artifact"
    );
  });

  it("fails closed when Mermaid public entrypoints are missing", () => {
    const cwd = createFixture();
    rmSync(resolve(cwd, "extensions/mermaid/dist/index.js"));
    rmSync(resolve(cwd, "extensions/mermaid/dist/index.d.ts"));

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["extension-mermaid"] })
    ).toEqual([
      "extensions/mermaid/dist/index.js is missing; required extension artifact",
      "extensions/mermaid/dist/index.d.ts is missing; required extension artifact",
    ]);
  });

  it("fails closed when the LaTeX worker is missing", () => {
    const cwd = createFixture();
    rmSync(resolve(cwd, "extensions/latex/dist/mathjax-worker.js"));

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["extension-latex"] })
    ).toEqual([
      "extensions/latex/dist/mathjax-worker.js is missing; required extension artifact",
    ]);
  });
});
