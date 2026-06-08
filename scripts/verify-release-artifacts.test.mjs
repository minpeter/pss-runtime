import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isMainModule,
  verifyReleaseArtifacts,
} from "./verify-release-artifacts.mjs";

const cliBinReadFailurePattern =
  /^apps\/coding-agent\/bin\/pss\.js: cannot read CLI bin target /;
const forbiddenModelName = ["Agent", "Model"].join("");
const runtimeRootDeclaration = [
  'export type { AgentHost } from "./execution/types";',
  'export type { AgentRun, RuntimeCreateLlmOptions, RuntimeInput, RuntimeLlm, RuntimeLlmContext, RuntimeLlmOutput, RuntimeLlmOutputPart } from "./llm";',
  "",
].join("\n");
const runtimeExecutionDeclaration = [
  'export { createInMemoryExecutionHost } from "./memory";',
  'export type { BackgroundScheduler, BackgroundSchedulerHost, CheckpointHost, DurableBackgroundHost, DurableNotificationResumeHost, EventHost, ExecutionTransactionHost, NotificationHost, RunHost, SessionHost } from "./capabilities";',
  'export type { AgentHostCapabilities, CheckpointStore, EventStore, ExecutionHost, ExecutionScheduler, ExecutionStore, ExecutionStoreTransaction, NotificationInbox, NotificationRecord, RunRecord, RunStore } from "./types";',
  'export type { RuntimeToolExecutionCheckpoint, RuntimeToolExecutionContext, RuntimeToolExecutionDecision, RuntimeToolRetryPolicy } from "../llm-tool-execution";',
  'export { ToolExecutionNeedsRecoveryError } from "../llm-tool-execution";',
  "",
].join("\n");
const runtimeCloudflareDeclaration = [
  'export { ackScheduledCloudflareRun, ackScheduledCloudflareSessionPrompt, createCloudflareAlarmScheduler, createCloudflareDurableObjectHost, drainAgentRun, drainCloudflareAlarm, InMemoryCloudflareDurableObjectStorage, listScheduledCloudflareRuns, listScheduledCloudflareSessionPrompts, rescheduleCloudflareAlarm } from "./index";',
  'export type { CloudflareAlarmAgent, CloudflareAlarmDrainSummary, CloudflareDurableObjectStorage, CloudflareScheduledSessionPrompt } from "./index";',
  "",
].join("\n");

let tempRoots = [];

function createFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pss-release-artifacts-"));
  tempRoots.push(cwd);

  for (const packageName of ["runtime", "coding-agent"]) {
    const packageRoot = fixturePackageRoot(cwd, packageName);
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "dist", "index.js"),
      "export const ok = true;\n"
    );
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify(
        packageName === "coding-agent"
          ? {
              bin: {
                pss: "./bin/pss.js",
                "pss-coding-agent": "./bin/pss.js",
              },
            }
          : {},
        null,
        2
      )
    );
    const declaration =
      packageName === "runtime"
        ? runtimeRootDeclaration
        : "export declare const ok: true;\n";
    writeFileSync(join(packageRoot, "dist", "index.d.ts"), declaration);
    if (packageName === "runtime") {
      mkdirSync(join(packageRoot, "dist", "execution"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "execution", "index.d.ts"),
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
        join(packageRoot, "dist", "llm.d.ts"),
        "export declare const ok: true;\n"
      );
    } else {
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
  }

  return cwd;
}

function fixturePackageRoot(cwd, packageName) {
  return packageName === "coding-agent"
    ? join(cwd, "apps", "coding-agent")
    : join(cwd, "packages", packageName);
}

function createAppsCodingAgentFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pss-release-artifacts-apps-"));
  tempRoots.push(cwd);

  mkdirSync(join(cwd, "packages", "runtime", "dist", "execution"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", "runtime", "dist", "index.js"),
    "export const ok = true;\n"
  );
  writeFileSync(
    join(cwd, "packages", "runtime", "dist", "index.d.ts"),
    runtimeRootDeclaration
  );
  writeFileSync(
    join(cwd, "packages", "runtime", "dist", "execution", "index.d.ts"),
    runtimeExecutionDeclaration
  );
  mkdirSync(join(cwd, "packages", "runtime", "dist", "cloudflare"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", "runtime", "dist", "cloudflare", "index.d.ts"),
    runtimeCloudflareDeclaration
  );
  writeFileSync(
    join(cwd, "packages", "runtime", "dist", "llm.d.ts"),
    "export declare const ok: true;\n"
  );
  writeFileSync(join(cwd, "packages", "runtime", "package.json"), "{}\n");

  mkdirSync(join(cwd, "apps", "coding-agent", "bin"), {
    recursive: true,
  });
  mkdirSync(join(cwd, "apps", "coding-agent", "dist"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "apps", "coding-agent", "package.json"),
    JSON.stringify(
      {
        bin: {
          pss: "./bin/pss.js",
          "pss-coding-agent": "./bin/pss.js",
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    join(cwd, "apps", "coding-agent", "bin", "pss.js"),
    "#!/usr/bin/env node\nimport '../dist/tui.js';\n",
    { mode: 0o755 }
  );
  writeFileSync(
    join(cwd, "apps", "coding-agent", "dist", "index.js"),
    "export const ok = true;\n"
  );
  writeFileSync(
    join(cwd, "apps", "coding-agent", "dist", "index.d.ts"),
    "export declare const ok: true;\n"
  );
  writeFileSync(
    join(cwd, "apps", "coding-agent", "dist", "tui.js"),
    "export const ok = true;\n"
  );

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

  it("supports publishable packages that live under apps", () => {
    const cwd = createAppsCodingAgentFixture();

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([]);
  });

  it("reports apps package root paths for moved package errors", () => {
    const cwd = createAppsCodingAgentFixture();
    writeFileSync(
      join(cwd, "apps", "coding-agent", "bin", "pss.js"),
      "import '../dist/tui.js';\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      ["apps/coding-agent/bin/pss.js: CLI bin target must start with a shebang"]
    );
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
      join(cwd, "apps", "coding-agent", "dist", "chunk.js"),
      "export const chunk = true;\n"
    );
    writeFileSync(
      join(cwd, "apps", "coding-agent", "dist", "index.js"),
      'export async function loadChunk() { return import("./chunk"); }\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "apps/coding-agent/dist/index.js: extensionless relative import ./chunk",
    ]);
  });

  it("rejects test and fixture files from package dist outputs", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "apps", "coding-agent", "dist", "web-fetch.test.js"),
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
      "apps/coding-agent/dist/web-fetch.test.js: test or fixture artifact must not be published",
    ]);
  });

  it("rejects missing CLI bin metadata for the coding-agent package", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "apps", "coding-agent", "package.json"),
      JSON.stringify({ bin: { pss: "./bin/pss.js" } })
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      [
        "apps/coding-agent/package.json: bin.pss-coding-agent must target ./bin/pss.js",
      ]
    );
  });

  it("rejects CLI bin targets without a shebang", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "apps", "coding-agent", "bin", "pss.js"),
      "import '../dist/tui.js';\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      ["apps/coding-agent/bin/pss.js: CLI bin target must start with a shebang"]
    );
  });

  it("rejects CLI bin targets without executable mode", () => {
    const cwd = createFixture();
    const binPath = join(cwd, "apps", "coding-agent", "bin", "pss.js");
    writeFileSync(binPath, "#!/usr/bin/env node\nimport '../dist/tui.js';\n");
    chmodSync(binPath, 0o644);

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      ["apps/coding-agent/bin/pss.js: CLI bin target must be executable"]
    );
  });

  it("skips CLI bin executable mode checks on Windows", () => {
    const cwd = createFixture();
    const binPath = join(cwd, "apps", "coding-agent", "bin", "pss.js");
    writeFileSync(binPath, "#!/usr/bin/env node\nimport '../dist/tui.js';\n");
    chmodSync(binPath, 0o644);

    expect(
      verifyReleaseArtifacts({
        cwd,
        packages: ["coding-agent"],
        platform: "win32",
      })
    ).toEqual([]);
  });

  it("reports CLI bin target read failures instead of throwing", () => {
    const cwd = createFixture();
    const binPath = join(cwd, "apps", "coding-agent", "bin", "pss.js");
    rmSync(binPath);
    mkdirSync(binPath);

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      [expect.stringMatching(cliBinReadFailurePattern)]
    );
  });

  it("allows direct AI SDK types in runtime public declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      `import type { LanguageModel, ToolSet } from "ai";\nexport interface AgentOptions { model: LanguageModel; tools?: ToolSet; }\n${runtimeRootDeclaration}`
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([]);
  });

  it("allows direct AI SDK message types in plugin runtime declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "plugins.d.ts"),
      'import type { RuntimeLlmContext } from "./llm";\nexport interface AgentEventContext { readonly history: RuntimeLlmContext["history"]; }\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([]);
  });

  it("rejects redundant runtime AI SDK names from root declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      `export type { AgentMessage, ${forbiddenModelName}, AgentRun, AgentTool, AgentTools, CreateLlmOptions, Llm, LlmContext, LlmOutput, LlmOutputPart, RuntimeCreateLlmOptions, RuntimeInput, RuntimeLlm, RuntimeLlmContext, RuntimeLlmOutput, RuntimeLlmOutputPart } from "./llm";\nexport type { AgentHost } from "./execution/types";\n`
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name AgentMessage",
      `packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name ${forbiddenModelName}`,
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name AgentTool",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name AgentTools",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name CreateLlmOptions",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name Llm",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name LlmContext",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name LlmOutput",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name LlmOutputPart",
    ]);
  });

  it("rejects internal runtime input names from root declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      `${runtimeRootDeclaration}export type { AgentRunInput, RunInput } from "./llm";\n`
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name AgentRunInput",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name RunInput",
    ]);
  });

  it("rejects internal agent loop names from root declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      `export { runAgentLoop, type AgentLoopResult } from "./agent-loop";\n${runtimeRootDeclaration}`
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name AgentLoopResult",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name runAgentLoop",
    ]);
  });

  it("rejects advanced execution contracts from root declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      `${runtimeRootDeclaration}export type { ExecutionHost, ExecutionScheduler, ExecutionStore, RuntimeToolExecutionContext } from "./execution";\nexport { ToolExecutionNeedsRecoveryError, createInMemoryExecutionHost } from "./execution";\n`
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name createInMemoryExecutionHost",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name ExecutionHost",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name ExecutionScheduler",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name ExecutionStore",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name RuntimeToolExecutionContext",
      "packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name ToolExecutionNeedsRecoveryError",
    ]);
  });

  it("rejects AgentRun stream API from runtime artifacts", () => {
    const cwd = createFixture();
    mkdirSync(join(cwd, "packages", "runtime", "dist", "session"), {
      recursive: true,
    });
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "session", "run.d.ts"),
      'import type { AgentEvent } from "./events";\nexport interface AgentRun { stream(): AsyncIterable<AgentEvent>; }\n'
    );
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "session", "run.js"),
      'throw new Error("AgentRun.stream() can only be consumed once");\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/session/run.d.ts: exposes AgentRun.stream() API",
      "packages/runtime/dist/session/run.js: exposes AgentRun.stream() member",
    ]);
  });

  it("allows direct AI SDK types inside internal runtime declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      runtimeRootDeclaration
    );
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "llm.d.ts"),
      'import type { LanguageModel, ToolSet } from "ai";\nexport interface RuntimeCreateLlmOptions { model: LanguageModel; tools?: ToolSet; }\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([]);
  });

  it("honors package filtering for runtime-only declaration checks", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      'import type { LanguageModel } from "ai";\nexport interface AgentOptions { model: LanguageModel; }\n'
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      []
    );
    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export AgentHost",
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export AgentRun",
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export RuntimeCreateLlmOptions",
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export RuntimeInput",
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export RuntimeLlm",
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export RuntimeLlmContext",
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export RuntimeLlmOutput",
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export RuntimeLlmOutputPart",
    ]);
  });

  it("requires the runtime execution declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(join(cwd, "packages", "runtime", "dist", "execution", "index.d.ts"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/execution/index.d.ts: missing execution runtime declaration",
    ]);
  });

  it("requires the runtime cloudflare declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(
      join(cwd, "packages", "runtime", "dist", "cloudflare", "index.d.ts")
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/cloudflare/index.d.ts: missing cloudflare runtime declaration",
    ]);
  });

  it("checks advanced runtime contracts on the execution declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "execution", "index.d.ts"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export AgentHostCapabilities",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export BackgroundScheduler",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export BackgroundSchedulerHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export CheckpointHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export CheckpointStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export createInMemoryExecutionHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export DurableBackgroundHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export DurableNotificationResumeHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export EventHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export EventStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionScheduler",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionStoreTransaction",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionTransactionHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export NotificationHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export NotificationInbox",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export NotificationRecord",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RunHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RunRecord",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RunStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionCheckpoint",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionContext",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionDecision",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolRetryPolicy",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ToolExecutionNeedsRecoveryError",
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
