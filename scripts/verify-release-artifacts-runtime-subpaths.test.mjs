import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  createFixture,
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
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentContext",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentContextFactoryOptions",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentContextOptions",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentContextPrefixOptions",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export AgentTurnDrainResult",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export AgentTurnDrainStopReason",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentTurnDrainOptions",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAlarmAgent",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAlarmDrainSummary",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectFetchOptions",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectId",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectNamespace",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectState",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectStorage",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectStub",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectStubOptions",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareScheduledThreadPrompt",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export InMemoryCloudflareDurableObjectStorage",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export ackScheduledCloudflareRun",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export ackScheduledCloudflareThreadPrompt",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export createCloudflareAlarmScheduler",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export createCloudflareAgentContext",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export createCloudflareDurableObjectHost",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export drainAgentTurn",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export drainAgentTurnWithBudget",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export drainCloudflareAlarm",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export fetchCloudflareDurableObject",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export getCloudflareDurableObjectStub",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export listScheduledCloudflareRuns",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export listScheduledCloudflareThreadPrompts",
      "packages/runtime/dist/platform/cloudflare/index.d.ts: missing explicit cloudflare runtime export rescheduleCloudflareAlarm",
    ]);
  });

  it("checks advanced runtime contracts on the execution declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "execution", "index.d.ts"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export CheckpointStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export DurableTurnInspectionResult",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export DurableTurnInspectionSource",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export DurableBackgroundHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export EventStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionScheduler",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionStoreTransaction",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export NotificationInbox",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export NotificationRecord",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export TurnRecord",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export TurnStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export TurnStatus",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionCheckpoint",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionContext",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionDecision",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolRetryPolicy",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ToolExecutionNeedsRecoveryError",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export inspectDurableTurn",
    ]);
  });

  it("checks memory helpers on the memory declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(cwd, "platform", "memory"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export createInMemoryExecutionHost",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryThreadStore",
    ]);
  });
});
