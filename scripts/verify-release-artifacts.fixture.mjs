import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const cliBinReadFailurePattern =
  /^apps\/coding-agent\/bin\/pss\.js: cannot read CLI bin target /;
export const forbiddenModelName = ["Agent", "Model"].join("");
export const runtimeRootDeclaration = [
  'export type { AgentHost } from "./execution/types";',
  'export type { AgentRun, RuntimeCreateLlmOptions, RuntimeInput, RuntimeLlm, RuntimeLlmContext, RuntimeLlmOutput, RuntimeLlmOutputPart } from "./llm";',
  "",
].join("\n");
export const runtimeExecutionDeclaration = [
  'export { createInMemoryExecutionHost } from "./memory";',
  'export type { BackgroundScheduler, BackgroundSchedulerHost, CheckpointHost, DurableBackgroundHost, DurableNotificationResumeHost, EventHost, ExecutionTransactionHost, NotificationHost, RunHost, SessionHost } from "./capabilities";',
  'export type { AgentHostCapabilities, CheckpointStore, EventStore, ExecutionHost, ExecutionScheduler, ExecutionStore, ExecutionStoreTransaction, NotificationInbox, NotificationRecord, RunRecord, RunStore } from "./types";',
  'export type { RuntimeToolExecutionCheckpoint, RuntimeToolExecutionContext, RuntimeToolExecutionDecision, RuntimeToolRetryPolicy } from "../llm-tool-execution";',
  'export { ToolExecutionNeedsRecoveryError } from "../llm-tool-execution";',
  "",
].join("\n");
export const runtimeCloudflareDeclaration = [
  'export { ackScheduledCloudflareRun, ackScheduledCloudflareSessionPrompt, createCloudflareAlarmScheduler, createCloudflareAgentContext, createCloudflareDurableObjectHost, drainAgentRun, drainCloudflareAlarm, fetchCloudflareDurableObject, getCloudflareDurableObjectStub, InMemoryCloudflareDurableObjectStorage, listScheduledCloudflareRuns, listScheduledCloudflareSessionPrompts, rescheduleCloudflareAlarm } from "./index";',
  'export type { CloudflareAgentContext, CloudflareAgentContextFactoryOptions, CloudflareAgentContextOptions, CloudflareAgentContextPrefixOptions, CloudflareAgentRunDrainOptions, CloudflareAlarmAgent, CloudflareAlarmDrainSummary, CloudflareDurableObjectFetchOptions, CloudflareDurableObjectId, CloudflareDurableObjectNamespace, CloudflareDurableObjectState, CloudflareDurableObjectStorage, CloudflareDurableObjectStub, CloudflareDurableObjectStubOptions, CloudflareScheduledSessionPrompt } from "./index";',
  "",
].join("\n");

let tempRoots = [];

export function createTrackedTempRoot(prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(cwd);
  return cwd;
}

export function createFixture() {
  const cwd = createTrackedTempRoot("pss-release-artifacts-");

  for (const packageName of ["runtime", "coding-agent"]) {
    const packageRoot = fixturePackageRoot(cwd, packageName);
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "dist", "index.js"),
      "export const ok = true;\n"
    );
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify(packageMetadata(packageName), null, 2)
    );
    writePackageDeclarationFixtures(cwd, packageName, packageRoot);
  }

  return cwd;
}

export function cleanupFixtures() {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots = [];
}

function packageMetadata(packageName) {
  return packageName === "coding-agent"
    ? {
        bin: {
          pss: "./bin/pss.js",
          "pss-coding-agent": "./bin/pss.js",
        },
      }
    : {};
}

function fixturePackageRoot(cwd, packageName) {
  return packageName === "coding-agent"
    ? join(cwd, "apps", "coding-agent")
    : join(cwd, "packages", packageName);
}

function writePackageDeclarationFixtures(cwd, packageName, packageRoot) {
  const declaration =
    packageName === "runtime"
      ? runtimeRootDeclaration
      : "export declare const ok: true;\n";
  writeFileSync(join(packageRoot, "dist", "index.d.ts"), declaration);

  if (packageName === "runtime") {
    writeRuntimeDeclarationFixtures(cwd, packageName);
    return;
  }

  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(
    join(packageRoot, "bin", "pss.js"),
    "#!/usr/bin/env node\nimport '../dist/tui.js';\n",
    { mode: 0o755 }
  );
  writeFileSync(
    join(packageRoot, "dist", "tui.js"),
    "export const ok = true;\n"
  );
}

function writeRuntimeDeclarationFixtures(cwd, packageName) {
  mkdirSync(join(cwd, "packages", packageName, "dist", "execution"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "execution", "index.d.ts"),
    runtimeExecutionDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "cloudflare"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "cloudflare", "index.d.ts"),
    runtimeCloudflareDeclaration
  );
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "llm.d.ts"),
    "export declare const ok: true;\n"
  );
}
