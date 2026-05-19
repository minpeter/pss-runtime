import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isMainModule,
  verifyReleaseArtifacts,
} from "./verify-release-artifacts.mjs";

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
    const declaration =
      packageName === "runtime"
        ? 'export type { AgentModel, AgentTools, RuntimeCreateLlmOptions, RuntimeLlm, RuntimeLlmContext, RuntimeLlmOutput } from "./llm";\n'
        : "export declare const ok: true;\n";
    writeFileSync(
      join(cwd, "packages", packageName, "dist", "index.d.ts"),
      declaration
    );
    if (packageName === "runtime") {
      writeFileSync(
        join(cwd, "packages", packageName, "dist", "llm.d.ts"),
        "export declare const ok: true;\n"
      );
    }
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

  it("rejects extensionless dynamic imports that would break Node ESM", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "coding-agent", "dist", "chunk.js"),
      "export const chunk = true;\n"
    );
    writeFileSync(
      join(cwd, "packages", "coding-agent", "dist", "index.js"),
      'export async function loadChunk() { return import("./chunk"); }\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/coding-agent/dist/index.js: extensionless relative import ./chunk",
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
      'import type { LanguageModel } from "ai";\nexport type AgentModel = LanguageModel;\nexport type { AgentTools, RuntimeCreateLlmOptions, RuntimeLlm, RuntimeLlmContext, RuntimeLlmOutput } from "./llm";\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/index.d.ts: root declaration exposes raw AI SDK token LanguageModel",
    ]);
  });

  it("allows raw AI SDK types inside allowlisted internal runtime declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      'export type { AgentModel, AgentTools, RuntimeCreateLlmOptions, RuntimeLlm, RuntimeLlmContext, RuntimeLlmOutput } from "./llm";\n'
    );
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "llm.d.ts"),
      'import type { LanguageModel } from "ai";\nexport type AgentModel = LanguageModel;\nexport type { AgentTools, RuntimeCreateLlmOptions, RuntimeLlm, RuntimeLlmContext, RuntimeLlmOutput } from "./llm";\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([]);
  });

  it("honors package filtering for runtime-only declaration checks", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      'import type { LanguageModel } from "ai";\nexport type AgentModel = LanguageModel;\n'
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      []
    );
    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/index.d.ts: root declaration exposes raw AI SDK token LanguageModel",
      "packages/runtime/dist/index.d.ts: missing explicit runtime alias AgentTools",
      "packages/runtime/dist/index.d.ts: missing explicit runtime alias RuntimeCreateLlmOptions",
      "packages/runtime/dist/index.d.ts: missing explicit runtime alias RuntimeLlm",
      "packages/runtime/dist/index.d.ts: missing explicit runtime alias RuntimeLlmContext",
      "packages/runtime/dist/index.d.ts: missing explicit runtime alias RuntimeLlmOutput",
    ]);
  });

  it("detects script entrypoints with encoded file URLs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pss-script path-"));
    tempRoots.push(cwd);
    const scriptPath = resolve(cwd, "verify script.mjs");

    expect(isMainModule(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    expect(
      isMainModule(pathToFileURL(scriptPath).href, `${scriptPath}.bak`)
    ).toBe(false);
  });
});
