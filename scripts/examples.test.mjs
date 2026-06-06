import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const examplePackages = [
  {
    name: "@minpeter/pss-example-basic",
    path: "examples/basic",
    requiredSource: "src/index.ts",
  },
  {
    name: "@minpeter/pss-example-plugin",
    path: "examples/plugin",
    requiredSource: "src/index.ts",
  },
  {
    name: "@minpeter/pss-example-subagent",
    path: "examples/subagent",
    requiredSource: "src/index.ts",
  },
];
const finalRunEventsLoopPattern =
  /for await \(const event of run\.events\(\)\) \{\s+console\.log\(event\);\s+\}$/;
const legacyLifecycleTerm = ["h", "o", "o", "k"].join("");
const legacyLifecyclePlural = `${legacyLifecycleTerm}s`;
const legacyLifecycleType = `Agent${["H", "o", "o", "k", "s"].join("")}`;
const legacyLifecycleAdapter = `pluginsTo${["H", "o", "o", "k", "s"].join("")}`;
const legacyRuntimeInputAdapter = `${legacyLifecyclePlural}ForRuntimeInput`;
const legacyAfterTurnRunner = `runAfterTurn${["H", "o", "o", "k"].join("")}`;
const legacyLifecycleOption = `${legacyLifecyclePlural}:`;
const legacyBeforeTurnName = `before${["T", "u", "r", "n"].join("")}`;
const legacyAfterTurnName = `after${["T", "u", "r", "n"].join("")}`;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

describe("examples workspace packages", () => {
  it("exposes examples as independent package.json workspaces", () => {
    const workspace = readText("pnpm-workspace.yaml");

    expect(workspace).toContain('- "examples/*"');

    for (const examplePackage of examplePackages) {
      const packageJsonPath = join(examplePackage.path, "package.json");
      const sourcePath = join(
        examplePackage.path,
        examplePackage.requiredSource
      );
      const packageJson = readJson(packageJsonPath);

      expect(packageJson.private).toBe(true);
      expect(packageJson.name).toBe(examplePackage.name);
      expect(packageJson.scripts.start).toBe(
        "tsx --conditions=@minpeter/pss-source src/index.ts"
      );
      expect(packageJson.dependencies["@minpeter/pss-runtime"]).toBe(
        "workspace:*"
      );
      expect(packageJson.dependencies["@ai-sdk/openai-compatible"]).toBe(
        "3.0.0-canary.48"
      );
      expect(packageJson.dependencies["@t3-oss/env-core"]).toBe("^0.13.11");
      expect(packageJson.dependencies.dotenv).toBe("^17.4.2");
      expect(packageJson.dependencies.zod).toBe("^4.4.3");
      expect(packageJson.dependencies).not.toHaveProperty(
        "@minpeter/pss-coding-agent"
      );
      expect(existsSync(sourcePath)).toBe(true);
    }
  });

  it("keeps root dev pointed at the basic example package", () => {
    const rootPackageJson = readJson("package.json");

    expect(rootPackageJson.scripts.dev).toBe(
      "pnpm --filter @minpeter/pss-example-basic start"
    );
  });

  it("includes plugin and subagent runtime API usage examples", () => {
    const basicSource = readText("examples/basic/src/index.ts");
    const pluginSource = readText("examples/plugin/src/index.ts");
    const subagentSource = readText("examples/subagent/src/index.ts");

    for (const source of [basicSource, pluginSource, subagentSource]) {
      expect(source).toContain("createOpenAICompatible");
      expect(source).toContain('loadEnv({ path: ".env"');
      expect(source).toContain(".send(");
      expect(source.trim()).toMatch(finalRunEventsLoopPattern);
      expect(source).not.toContain("RuntimeLlm");
      expect(source).not.toContain("@minpeter/pss-coding-agent");
    }

    expect(pluginSource).toContain("plugins:");
    expect(pluginSource).toContain("events:");
    expect(pluginSource).toContain("event.type");
    expect(pluginSource).not.toContain(legacyLifecycleOption);
    expect(pluginSource).not.toContain(legacyLifecycleType);
    expect(pluginSource).not.toContain(legacyBeforeTurnName);
    expect(pluginSource).not.toContain(legacyAfterTurnName);
    expect(pluginSource).not.toContain("process.argv");

    expect(subagentSource).toContain("subagents: [researcher]");
    expect(subagentSource).toContain('name: "researcher"');
    expect(subagentSource).toContain("coordinator.send(");
    expect(subagentSource).not.toContain("session.kill()");
  });
});

describe("runtime plugin source surface", () => {
  it("does not keep the legacy lifecycle adapter as a runtime layer", () => {
    const agentLoopSource = readText("packages/runtime/src/agent-loop.ts");
    const agentSource = readText("packages/runtime/src/agent.ts");
    const pluginSource = readText("packages/runtime/src/plugins.ts");
    const runtimeInputSource = readText(
      "packages/runtime/src/session/runtime-input.ts"
    );
    const sessionSource = readText("packages/runtime/src/session/session.ts");
    const pluginsSource = readText("packages/runtime/src/plugins.ts");

    expect(existsSync(`packages/runtime/src/${legacyLifecyclePlural}.ts`)).toBe(
      false
    );
    for (const source of [
      agentLoopSource,
      agentSource,
      pluginSource,
      runtimeInputSource,
      sessionSource,
      pluginsSource,
    ]) {
      expect(source).not.toContain(legacyLifecycleType);
      expect(source).not.toContain(legacyLifecycleAdapter);
      expect(source).not.toContain(legacyRuntimeInputAdapter);
      expect(source).not.toContain(legacyAfterTurnRunner);
      expect(source).not.toContain(legacyLifecycleOption);
    }

    expect(pluginsSource).toContain("export interface AgentEventContext");
    expect(pluginsSource).toContain("export interface AgentPlugin");
    expect(pluginsSource).toContain("export function runEventPlugins");
  });
});
