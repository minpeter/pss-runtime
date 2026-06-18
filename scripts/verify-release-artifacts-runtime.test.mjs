import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  createFixture,
  forbiddenModelName,
  runtimeRootDeclaration,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

const removedRuntimeModelNames = [
  ["Runtime", "Create", "Llm", "Options"].join(""),
  ["Runtime", "Llm"].join(""),
  ["Runtime", "Llm", "Context"].join(""),
  ["Runtime", "Llm", "Output"].join(""),
  ["Runtime", "Llm", "Output", "Part"].join(""),
];
const removedRuntimeModelValueName = ["create", "Llm"].join("");

describe("verifyReleaseArtifacts runtime declaration checks", () => {
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
      'import type { ModelMessage } from "ai";\nexport interface AgentEventContext { readonly history: readonly ModelMessage[]; }\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([]);
  });

  it("rejects redundant runtime AI SDK names from root declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      `export type { AgentMessage, ${forbiddenModelName}, AgentRun, AgentTool, AgentTools, CreateLlmOptions, Llm, LlmContext, LlmOutput, LlmOutputPart, ${removedRuntimeModelNames.join(", ")}, RuntimeInput } from "./llm";\nexport type { AgentHost } from "./execution/types";\n`
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
      ...removedRuntimeModelNames.map(
        (name) =>
          `packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name ${name}`
      ),
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

  it("rejects runtime LLM adapter contracts inside internal runtime declarations", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "index.d.ts"),
      `${runtimeRootDeclaration}export { ${removedRuntimeModelValueName} } from "./llm";\n`
    );
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "llm.d.ts"),
      `import type { LanguageModel, ToolSet } from "ai";\nexport declare function ${removedRuntimeModelValueName}(): void;\nexport interface ${removedRuntimeModelNames[0]} { model: LanguageModel; tools?: ToolSet; }\n`
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      `packages/runtime/dist/index.d.ts: root declaration exposes internal runtime name ${removedRuntimeModelValueName}`,
      `packages/runtime/dist/llm.d.ts: exposes removed runtime LLM adapter name ${removedRuntimeModelValueName}`,
      `packages/runtime/dist/llm.d.ts: exposes removed runtime LLM adapter name ${removedRuntimeModelNames[0]}`,
    ]);
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
      "packages/runtime/dist/index.d.ts: missing explicit root runtime export RuntimeInput",
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

  it("checks Cloudflare Worker helpers on the cloudflare declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "cloudflare", "index.d.ts"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentContext",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentContextFactoryOptions",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentContextOptions",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentContextPrefixOptions",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAgentRunDrainOptions",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAlarmAgent",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareAlarmDrainSummary",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectFetchOptions",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectId",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectNamespace",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectState",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectStorage",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectStub",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareDurableObjectStubOptions",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export CloudflareScheduledThreadPrompt",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export InMemoryCloudflareDurableObjectStorage",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export ackScheduledCloudflareRun",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export ackScheduledCloudflareThreadPrompt",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export createCloudflareAlarmScheduler",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export createCloudflareAgentContext",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export createCloudflareDurableObjectHost",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export drainAgentRun",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export drainCloudflareAlarm",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export fetchCloudflareDurableObject",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export getCloudflareDurableObjectStub",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export listScheduledCloudflareRuns",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export listScheduledCloudflareThreadPrompts",
      "packages/runtime/dist/cloudflare/index.d.ts: missing explicit cloudflare runtime export rescheduleCloudflareAlarm",
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
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export createInMemoryExecutionHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export DurableBackgroundHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export EventStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionHost",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionScheduler",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ExecutionStoreTransaction",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export NotificationInbox",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export NotificationRecord",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RunRecord",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RunStore",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionCheckpoint",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionContext",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolExecutionDecision",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export RuntimeToolRetryPolicy",
      "packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ToolExecutionNeedsRecoveryError",
    ]);
  });
});
