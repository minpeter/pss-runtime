import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  createFixture,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

function fileDeclarationPath(cwd) {
  return join(
    cwd,
    "packages",
    "runtime",
    "dist",
    "platform",
    "file",
    "index.d.ts"
  );
}

describe("verifyReleaseArtifacts file declaration checks", () => {
  it("requires the runtime file declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(fileDeclarationPath(cwd));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/file/index.d.ts: missing file runtime declaration",
    ]);
  });

  it("checks Node local helpers on the file declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(fileDeclarationPath(cwd), "export {};\n");

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export FileExecutionStore",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export FileThreadStore",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeFileAgentContext",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeFileAgentContextFactoryOptions",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeFileAgentContextOptions",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export FileHostOptions",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeScheduledThreadPrompt",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeScheduledWorkAppendOptions",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeScheduledWorkDrainOptions",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeScheduledWorkDrainResult",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeScheduledWorkListOptions",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export NodeScheduledWorkRunContext",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export ackScheduledNodeRun",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export ackScheduledNodeThreadPrompt",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export appendScheduledNodeRun",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export appendScheduledNodeThreadPrompt",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export createNodeFileAgentContext",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export createFileHost",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export createFileScheduler",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export drainScheduledNodeWork",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export listScheduledNodeRuns",
      "packages/runtime/dist/platform/file/index.d.ts: missing explicit file runtime export listScheduledNodeThreadPrompts",
    ]);
  });
});
