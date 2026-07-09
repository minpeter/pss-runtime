import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS,
  REQUIRED_RUNTIME_CLOUDFLARE_WORKER_EXPORTS,
  REQUIRED_RUNTIME_EXECUTION_EXPORTS,
} from "./verify-release-artifacts/runtime-public-surface.mjs";
import {
  cleanupFixtures,
  createFixture,
  runtimeCloudflareWorkerDeclaration,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

function runtimeDistDeclaration(cwd, ...segments) {
  return join(cwd, "packages", "runtime", "dist", ...segments, "index.d.ts");
}

describe("verifyReleaseArtifacts runtime subpath checks", () => {
  it("requires the runtime execution declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(join(cwd, "packages", "runtime", "dist", "execution", "index.d.ts"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/execution/index.d.ts: missing execution runtime declaration",
    ]);
  });

  it("requires the runtime cloudflare declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(runtimeDistDeclaration(cwd, "platform", "cloudflare"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing cloudflare runtime declaration",
    ]);
  });

  it("requires the runtime memory declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(runtimeDistDeclaration(cwd, "platform", "memory"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/memory/index.d.ts: missing memory runtime declaration",
    ]);
  });

  it("checks Cloudflare Worker helpers on the cloudflare declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(cwd, "platform", "cloudflare"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      ...REQUIRED_RUNTIME_CLOUDFLARE_WORKER_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export ${name}`
      ),
      ...REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export ${name}`
      ),
    ]);
  });

  it("checks Cloudflare Agents helpers on the canonical cloudflare declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(cwd, "platform", "cloudflare"),
      runtimeCloudflareWorkerDeclaration
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual(
      REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export ${name}`
      )
    );
  });

  it("checks advanced runtime contracts on the execution declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "execution", "index.d.ts"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual(
      REQUIRED_RUNTIME_EXECUTION_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ${name}`
      )
    );
  });

  it("reports required exports whose names are substrings of present exports", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(cwd, "platform", "memory"),
      'export { createInMemoryHost } from "./index";\n'
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export InMemoryHost",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export InMemoryExecutionScheduler",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryScheduledThreadPrompt",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryScheduledWorkListOptions",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryThreadStore",
    ]);
  });

  it("checks memory helpers on the memory declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(cwd, "platform", "memory"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export createInMemoryHost",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export InMemoryHost",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export InMemoryExecutionScheduler",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryScheduledThreadPrompt",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryScheduledWorkListOptions",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryThreadStore",
    ]);
  });
});
