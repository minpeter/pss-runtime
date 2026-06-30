import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import { REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS } from "./verify-release-artifacts/runtime-public-surface.mjs";
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

  it("requires the runtime cloudflare-agents declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(runtimeDistDeclaration(cwd, "platform", "cloudflare-agents"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing cloudflare-agents runtime declaration",
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

  it("checks Cloudflare Agents helpers on the cloudflare-agents declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(cwd, "platform", "cloudflare-agents"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsCallbackName",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsDurableObjectContext",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsEventHandler",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsExecutionHostOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsFiberContext",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsFiberPayload",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsFiberRecoveryContext",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsFiberRecoveryResult",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsFiberRetrySchedulerOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsFiberSchedulerOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsFiberStatus",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPayloadTrustOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPlatformAgent",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPlatformContext",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPlatformContextOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPlatformFactoryOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPlatformPrefixGuard",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPlatformPrefixGuardOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPrefixGuard",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsPrefixGuardOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsResumeRun",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsResumableAgent",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsRunFiberPayload",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsRunContext",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsRunSource",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsSchedule",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsScheduleOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsScheduledRunContext",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsScheduledThreadPrompt",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsStartFiberOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsStartFiberResult",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsThreadFiberPayload",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsThreadPromptContext",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export CloudflareAgentsTurnDrainOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export DispatchCloudflareAgentsNotificationInput",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export RecoverCloudflareAgentsFiberOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export ResumeScheduledCloudflareAgentsFiberOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export SourceCloudflareAgentsNotificationIdempotencyKeyInput",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export StartCloudflareAgentsResumeFiberOptions",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export ackScheduledCloudflareAgentsRun",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export ackScheduledCloudflareAgentsThreadPrompt",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export areCloudflareAgentsPayloadsEquivalent",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export cloudflareAgentsFiberIdempotencyKey",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export cloudflareAgentsFiberMetadata",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export cloudflareAgentsFiberName",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export cloudflareAgentsRunPayload",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export cloudflareAgentsThreadPayload",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export cloudflareAgentsTrustFailureReason",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export createCloudflareAgentsExecutionHost",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export createCloudflareAgentsFiberScheduler",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export createCloudflareAgentsFiberRetryScheduler",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export createCloudflareAgentsPlatformContext",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export defaultCloudflareAgentsDelayedResumeCallback",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export dispatchCloudflareAgentsNotification",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export isCloudflareAgentsPayloadTrusted",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export isCloudflareAgentsRecoveryContextTrusted",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export listScheduledCloudflareAgentsRuns",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export listScheduledCloudflareAgentsThreadPrompts",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export parseCloudflareAgentsFiberPayload",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export pssRunFiberName",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export pssThreadFiberName",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export recoverCloudflareAgentsFiber",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export rejectedCloudflareAgentsFiberResult",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export rescheduleCloudflareAgentsSchedule",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export resumeScheduledCloudflareAgentsFiber",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export sourceCloudflareAgentsNotificationIdempotencyKey",
      "packages/runtime/dist/platform/cloudflare-agents/index.d.ts: missing explicit cloudflare-agents runtime export startCloudflareAgentsResumeFiber",
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
