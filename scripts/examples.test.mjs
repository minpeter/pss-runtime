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
    name: "@minpeter/pss-example-sync-subagent",
    path: "examples/sync-subagent",
    requiredSource: "src/index.ts",
  },
  {
    name: "@minpeter/pss-example-background-subagent",
    path: "examples/background-subagent",
    requiredSource: "src/index.ts",
  },
];
const appPackages = [
  {
    name: "@minpeter/pss-coding-agent",
    path: "apps/coding-agent",
    requiredSource: "src/index.ts",
    buildScript: "tsdown",
  },
];
const finalRunEventsLoopPattern =
  /for await \(const event of run\.events\(\)\) \{\s+console\.log\(event\);\s+\}$/;

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
      const startScript =
        examplePackage.startScript ??
        "tsx --conditions=@minpeter/pss-source src/index.ts";

      expect(packageJson.private).toBe(true);
      expect(packageJson.name).toBe(examplePackage.name);
      expect(packageJson.scripts.start).toBe(startScript);
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

  it("exposes apps as independent workspace packages", () => {
    const workspace = readText("pnpm-workspace.yaml");
    const rootPackageJson = readJson("package.json");
    const rootTsconfig = readJson("tsconfig.json");

    expect(workspace).toContain('- "apps/*"');
    expect(rootPackageJson.workspaces).toContain("apps/*");
    expect(rootPackageJson.scripts["dev:tui"]).toBe(
      "tsx --conditions=@minpeter/pss-source apps/coding-agent/src/tui.ts"
    );
    expect(rootTsconfig.include).toContain("apps/*/src/**/*.ts");

    for (const appPackage of appPackages) {
      const packageJsonPath = join(appPackage.path, "package.json");
      const sourcePath = join(appPackage.path, appPackage.requiredSource);
      const packageJson = readJson(packageJsonPath);

      expect(packageJson.name).toBe(appPackage.name);
      expect(packageJson.scripts.build).toBe(appPackage.buildScript);
      expect(packageJson.dependencies["@minpeter/pss-runtime"]).toBe(
        "workspace:^"
      );
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

  it("includes plugin and basic runtime API usage examples", () => {
    const basicSetupSource = readText("examples/basic/src/setup.ts");
    const basicIndexSource = readText("examples/basic/src/index.ts");
    const pluginSource = readText("examples/plugin/src/index.ts");

    for (const source of [basicSetupSource, pluginSource]) {
      expect(source).toContain("createOpenAICompatible");
      expect(source).toContain('loadEnv({ path: ".env"');
      expect(source).not.toContain("RuntimeLlm");
      expect(source).not.toContain("@minpeter/pss-coding-agent");
    }

    expect(basicSetupSource).toContain('session("default")');
    expect(basicIndexSource).toContain("readline");
    expect(basicIndexSource).toContain("session.send");
    expect(basicIndexSource).toContain("/quit");
    expect(basicIndexSource).toContain("drain(");

    expect(pluginSource).toContain(".send(");
    expect(pluginSource.trim()).toMatch(finalRunEventsLoopPattern);
    expect(pluginSource).toContain("plugins:");
    expect(pluginSource).toContain("events:");
    expect(pluginSource).toContain("event.type");
    expect(pluginSource).not.toContain("process.argv");
  });

  it("keeps the sync-subagent example focused on conversation plugins and file reads", () => {
    const packageJson = readJson("examples/sync-subagent/package.json");
    const indexSource = readText("examples/sync-subagent/src/index.ts");
    const setupSource = readText("examples/sync-subagent/src/setup.ts");
    const agentsSource = readText("examples/sync-subagent/src/agents.ts");
    const conversationPluginSource = readText(
      "examples/sync-subagent/src/conversation-plugin.ts"
    );
    const delegateToolSource = readText(
      "examples/sync-subagent/src/delegate-tool.ts"
    );
    const readFileToolSource = readText(
      "examples/sync-subagent/src/read-file-tool.ts"
    );

    expect(packageJson.scripts.start).toBe(
      "tsx --conditions=@minpeter/pss-source src/index.ts"
    );
    expect(packageJson.scripts).not.toHaveProperty("start:background");
    expect(packageJson.scripts).not.toHaveProperty("start:background:wait");

    expect(setupSource).toContain("createExampleRuntime");
    expect(setupSource).toContain("createOpenAICompatible");
    expect(indexSource).toContain("readline");
    expect(indexSource).toContain("session.send");
    expect(indexSource).toContain("/quit");
    expect(indexSource).toContain("kb/");
    expect(indexSource).not.toContain("subagents:");

    expect(agentsSource).toContain('namespace: "reader"');
    expect(agentsSource).toContain("plugins:");
    expect(agentsSource).toContain("createConversationTagPlugin");
    expect(agentsSource).toContain("createDelegateToReaderTool");
    expect(agentsSource).toContain("read_file: createReadFileTool()");
    expect(agentsSource).not.toContain("subagents:");

    expect(conversationPluginSource).toContain('action: "transform"');
    expect(conversationPluginSource).toContain("user-text");

    expect(delegateToolSource).toContain("delegate_to_reader");
    expect(delegateToolSource).toContain("delegateUserInput");
    expect(delegateToolSource).not.toContain('mode: "background"');
    expect(delegateToolSource).not.toContain("resumeBackgroundChildRun");

    expect(readFileToolSource).toContain("readFile");
    expect(readFileToolSource).toContain("fixtures");
    expect(readFileToolSource).toContain("kb");
    expect(existsSync("examples/sync-subagent/fixtures/kb/pricing.md")).toBe(
      true
    );
    expect(existsSync("examples/sync-subagent/fixtures/kb/faq.md")).toBe(true);
    expect(existsSync("examples/sync-subagent/src/background.ts")).toBe(false);
    expect(existsSync("examples/sync-subagent/src/delegation.ts")).toBe(false);
  });

  it("keeps the background-subagent example focused on durable background delegation", () => {
    const packageJson = readJson("examples/background-subagent/package.json");
    const indexSource = readText("examples/background-subagent/src/index.ts");
    const agentsSource = readText("examples/background-subagent/src/agents.ts");
    const delegateToolSource = readText(
      "examples/background-subagent/src/delegate-tool.ts"
    );
    const backgroundDelegationSource = readText(
      "examples/background-subagent/src/background-delegation.ts"
    );
    const localHostSource = readText(
      "examples/background-subagent/src/local-host.ts"
    );

    expect(packageJson.scripts.start).toBe(
      "tsx --conditions=@minpeter/pss-source src/index.ts"
    );
    expect(packageJson.scripts).not.toHaveProperty("start:cli");
    const setupSource = readText("examples/background-subagent/src/setup.ts");

    expect(setupSource).toContain("createExampleRuntime");
    expect(setupSource).toContain("localHost");
    expect(indexSource).toContain("readline");
    expect(indexSource).toContain("session.send");
    expect(indexSource).toContain("host.resumeSession");
    expect(indexSource).toContain("/quit");
    expect(indexSource).toContain("kb/");
    expect(
      existsSync("examples/background-subagent/fixtures/kb/product.md")
    ).toBe(true);
    expect(indexSource).not.toContain("subagents:");
    expect(existsSync("examples/background-subagent/src/cli.ts")).toBe(false);

    expect(agentsSource).toContain("background_output");
    expect(agentsSource).toContain("createDelegateToReaderTool");
    expect(agentsSource).toContain("createConversationTagPlugin");
    expect(agentsSource).not.toContain("subagents:");

    expect(delegateToolSource).toContain("launchDurableBackgroundDelegation");
    expect(backgroundDelegationSource).toContain("task_id");
    expect(backgroundDelegationSource).toContain("<system-reminder>");

    expect(localHostSource).toContain('backgroundSubagents: "durable"');
    expect(localHostSource).toContain("resumeSession");
    expect(existsSync("examples/background-subagent/src/app-agent.ts")).toBe(
      true
    );
  });
});
