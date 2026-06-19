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
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export FileExecutionStore",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export FileSessionStore",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export FileThreadStore",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeFileAgentContext",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeFileAgentContextFactoryOptions",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeFileAgentContextOptions",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeFileExecutionHostOptions",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeFileThreadHostOptions",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeScheduledThreadPrompt",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeScheduledWorkAppendOptions",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeScheduledWorkDrainOptions",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeScheduledWorkDrainResult",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeScheduledWorkListOptions",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export NodeScheduledWorkRunContext",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export ackScheduledNodeRun",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export ackScheduledNodeThreadPrompt",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export appendScheduledNodeRun",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export appendScheduledNodeThreadPrompt",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export createNodeFileAgentContext",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export createNodeFileExecutionHost",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export createNodeFileScheduler",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export createNodeFileThreadHost",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export drainScheduledNodeWork",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export listScheduledNodeRuns",
      "packages/runtime/dist/platform/node/index.d.ts: missing explicit node runtime export listScheduledNodeThreadPrompts",
    ]);
  });
});
