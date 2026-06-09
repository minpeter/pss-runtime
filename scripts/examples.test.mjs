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
const appPackages = [
  {
    name: "@minpeter/pss-agent-worker",
    path: "apps/agent-worker",
    requiredSource: "src/worker/index.ts",
    devScript:
      "tsx --conditions=@minpeter/pss-source scripts/dev-local.ts",
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

      expect(packageJson.private).toBe(true);
      expect(packageJson.name).toBe(appPackage.name);
      expect(packageJson.scripts.dev).toBe(appPackage.devScript);
      expect(packageJson.dependencies["@minpeter/pss-runtime"]).toBe(
        "workspace:*"
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
    expect(pluginSource).not.toContain("process.argv");

    expect(subagentSource).toContain("subagents: [researcher]");
    expect(subagentSource).toContain('name: "researcher"');
    expect(subagentSource).toContain("coordinator.send(");
    expect(subagentSource).not.toContain("session.kill()");
  });

  it("includes a background subagent task example", () => {
    const packageJson = readJson("examples/subagent/package.json");
    const backgroundSource = readText("examples/subagent/src/background.ts");
    const backgroundWaitSource = readText(
      "examples/subagent/src/background-wait.ts"
    );
    const localBackgroundModelSource = readText(
      "examples/subagent/src/local-background-model.ts"
    );

    expect(packageJson.scripts["start:background"]).toBe(
      "tsx --conditions=@minpeter/pss-source src/background.ts"
    );
    expect(packageJson.scripts["start:background:wait"]).toBe(
      "tsx --conditions=@minpeter/pss-source src/background-wait.ts"
    );
    expect(backgroundSource).toContain("subagents: [researcher]");
    expect(backgroundSource).toContain("run_in_background: true");
    expect(backgroundSource).toContain("background_output");
    expect(backgroundSource).toContain("task_id");
    expect(backgroundSource).toContain("background_cancel");
    expect(backgroundSource).toContain('coordinator.session("default")');
    expect(backgroundSource).toContain("session.send(");
    expect(backgroundSource.trim()).toMatch(finalRunEventsLoopPattern);
    expect(backgroundSource).not.toContain("@minpeter/pss-coding-agent");

    expect(backgroundWaitSource).toContain("subagents: [researcher]");
    expect(backgroundWaitSource).toContain("run_in_background: true");
    expect(backgroundWaitSource).toContain(
      'import { localHost } from "./local-host"'
    );
    expect(backgroundWaitSource).toContain(
      "localHost({ agent: createCoordinator })"
    );
    expect(backgroundWaitSource).toContain("host.resumeSession()");
    expect(backgroundWaitSource).toContain("background_output");
    expect(backgroundWaitSource).toContain("block: true");
    expect(backgroundWaitSource).not.toContain("@minpeter/pss-coding-agent");

    expect(existsSync("examples/subagent/src/local-host.ts")).toBe(true);
    expect(existsSync("examples/subagent/src/local-background-host.ts")).toBe(
      false
    );
    const localHostSource = readText("examples/subagent/src/local-host.ts");

    expect(localHostSource).toContain("createInMemoryExecutionHost");
    expect(localHostSource).toContain('backgroundSubagents: "durable"');
    expect(localHostSource).toContain("resumeSession");
    expect(localHostSource).toContain("agent().resume(");
    expect(localHostSource).toContain("ResumeSessionOptions");

    expect(localBackgroundModelSource).toContain('"delegate_to_researcher"');
    expect(localBackgroundModelSource).toContain('"background_output"');
    expect(localBackgroundModelSource).not.toContain("createOpenAICompatible");
  });
});
