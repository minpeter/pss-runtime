import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts.mjs";

let tempRoots = [];

function createFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pss-release-artifacts-"));
  tempRoots.push(cwd);

  for (const packageName of ["runtime", "coding-agent"]) {
    mkdirSync(join(cwd, "packages", packageName, "dist"), { recursive: true });
    writeFileSync(
      join(cwd, "packages", packageName, "dist", "index.js"),
      "export const ok = true;\n"
    );
    writeFileSync(
      join(cwd, "packages", packageName, "dist", "index.d.ts"),
      "export declare const ok: true;\n"
    );
  }

  return cwd;
}

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots = [];
});

describe("verifyReleaseArtifacts", () => {
  it("passes when package dist outputs contain publish-safe ESM artifacts", () => {
    const cwd = createFixture();

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([]);
  });

  it("rejects extensionless relative imports that would break Node ESM", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "helper.js"),
      "export const helper = true;\n"
    );
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.js"),
      'import "./helper";\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/index.js: extensionless relative import ./helper",
    ]);
  });

  it("rejects test and fixture files from package dist outputs", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "coding-agent", "dist", "web-fetch.test.js"),
      "export {};\n"
    );
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "test-fixtures.d.ts"),
      "export {};\n"
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/test-fixtures.d.ts: test or fixture artifact must not be published",
      "packages/coding-agent/dist/web-fetch.test.js: test or fixture artifact must not be published",
    ]);
  });

  it("rejects raw AI SDK canary types from runtime public declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      'import type { LanguageModel } from "ai";\nexport type AgentModel = LanguageModel;\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/index.d.ts:1: unauthorized runtime declaration token LanguageModel",
      "packages/runtime/dist/index.d.ts:2: unauthorized runtime declaration token LanguageModel",
    ]);
  });
});
