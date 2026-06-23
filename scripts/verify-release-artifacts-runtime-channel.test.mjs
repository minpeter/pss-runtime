import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  createFixture,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

function runtimeChannelDeclaration(cwd) {
  return join(cwd, "packages", "runtime", "dist", "channel", "index.d.ts");
}

describe("verifyReleaseArtifacts runtime channel declaration checks", () => {
  it("requires the runtime channel declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(runtimeChannelDeclaration(cwd));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/channel/index.d.ts: missing channel runtime declaration",
    ]);
  });

  it("checks channel adapter contracts on the channel declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(runtimeChannelDeclaration(cwd), "export {};\n");

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/channel/index.d.ts: missing explicit channel runtime export ChannelAssistantDelivery",
      "packages/runtime/dist/channel/index.d.ts: missing explicit channel runtime export ChannelAssistantTextDelivery",
      "packages/runtime/dist/channel/index.d.ts: missing explicit channel runtime export ChannelInboundMessage",
      "packages/runtime/dist/channel/index.d.ts: missing explicit channel runtime export projectChannelAssistantDelivery",
    ]);
  });
});
