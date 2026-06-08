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
    name: "@minpeter/pss-example-cloudflare-edge-subagent",
    path: "examples/cloudflare-edge-subagent",
    requiredSource: "src/index.ts",
    startScript:
      "tsx --conditions=@minpeter/pss-source src/worker-simulation.ts",
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
const legacyCloudflareSessionKeyPattern =
  /`\$\{this\.#prefix\}:\$\{encodeURIComponent\(key\)\}`/;
const removedTurnModeEnvName = ["PSS", "TURN", "MODE"].join("_");

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

  it("uses a Cloudflare Worker/Durable Object adapter surface", () => {
    const packageJson = readJson(
      "examples/cloudflare-edge-subagent/package.json"
    );
    const source = readText("examples/cloudflare-edge-subagent/src/index.ts");
    const hostSource = readText(
      "examples/cloudflare-edge-subagent/src/cloudflare-host.ts"
    );
    const storeSource = readText(
      "examples/cloudflare-edge-subagent/src/cloudflare-execution-store.ts"
    );
    const workerSource = readText(
      "examples/cloudflare-edge-subagent/src/worker.ts"
    );
    const workerRouteSource = readText(
      "examples/cloudflare-edge-subagent/src/worker-route.ts"
    );
    const alarmDrainerSource = readText(
      "examples/cloudflare-edge-subagent/src/cloudflare-alarm-drainer.ts"
    );
    const workerTsconfig = readJson(
      "examples/cloudflare-edge-subagent/tsconfig.worker.json"
    );
    const readme = readText("examples/cloudflare-edge-subagent/README.md");

    expect(packageJson.scripts["start:worker-sim"]).toBe(
      "tsx --conditions=@minpeter/pss-source src/worker-simulation.ts"
    );
    expect(packageJson.scripts["start:cli"]).toBe(
      "tsx --conditions=@minpeter/pss-source src/index.ts"
    );
    expect(packageJson.scripts["typecheck:worker"]).toBe(
      "tsc -p tsconfig.worker.json --noEmit"
    );
    expect(packageJson.scripts["dev:worker"]).toBe("wrangler dev");
    expect(packageJson.scripts["deploy:worker"]).toBe("wrangler deploy");
    expect(packageJson.devDependencies.wrangler).toBeDefined();
    expect(source).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(source).not.toContain(removedTurnModeEnvName);
    expect(hostSource).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(readme).not.toContain(removedTurnModeEnvName);
    expect(readme).not.toContain("fake host");
    expect(readme).not.toContain("in-memory fake");
    expect(readme).toContain("support-agent");
    expect(readme).toContain("dev:worker");
    expect(source).toContain(
      'import { workerStorePrefix } from "./worker-constants"'
    );
    expect(source).not.toContain('"cloudflare-edge-subagent-demo"');
    expect(hostSource).toContain("createCloudflareDurableObjectHost");
    expect(hostSource).toContain("createCloudflareAlarmScheduler");
    expect(storeSource).toContain("DurableObjectExecutionStore");
    expect(workerSource).toContain("export class AgentDurableObject");
    expect(workerSource).toContain("alarm()");
    expect(workerSource).toContain("routeWorkerRequest");
    expect(workerRouteSource).toContain("sessionKeyFromRoute");
    expect(workerSource).not.toContain('idFromName("default")');
    expect(workerSource).not.toContain('url.pathname === "/alarm"');
    expect(alarmDrainerSource).toContain("agent.resume(");
    expect(alarmDrainerSource).toContain("ackScheduledCloudflareRun");
    expect(alarmDrainerSource).toContain("rescheduleCloudflareAlarm");
    expect(hostSource).toContain("setAlarm");
    expect(workerTsconfig.compilerOptions.types).toEqual([
      "@cloudflare/workers-types",
    ]);
    const sessionStoreSource = readText(
      "examples/cloudflare-edge-subagent/src/durable-object-session-store.ts"
    );
    expect(sessionStoreSource).toContain('storeKey(this.#prefix, "session"');
    expect(sessionStoreSource).not.toMatch(legacyCloudflareSessionKeyPattern);
  });

  it("drives Cloudflare scheduled runs and session prompts through stored alarms", async () => {
    const {
      InMemoryCloudflareDurableObjectStorage,
      ackScheduledCloudflareRun,
      ackScheduledCloudflareSessionPrompt,
      createCloudflareDurableObjectHost,
      listScheduledCloudflareRuns,
      listScheduledCloudflareSessionPrompts,
    } = await import(
      "../examples/cloudflare-edge-subagent/src/cloudflare-host.ts"
    );
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ storage });
    const runId = "background:bg_cloudflare_delayed";
    const idempotencyKey = "background-complete:example:bg_delayed";
    const notificationRunId = "notification-run-delayed";

    await host.scheduler.enqueueRun(runId);
    await host.scheduler.resumeSession("example", {
      idempotencyKey,
      runId: notificationRunId,
    });
    await host.store.notifications.enqueue({
      idempotencyKey,
      input: { text: "ready", type: "user-text" },
      notificationId: "notification-delayed",
      runId: notificationRunId,
      sessionKey: "example",
      status: "pending",
    });

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      runId,
    ]);
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      runId,
    ]);
    await ackScheduledCloudflareRun(storage, runId);
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([]);
    const prompt = {
      idempotencyKey,
      runId: notificationRunId,
      sessionKey: "example",
    };
    await expect(
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([prompt]);
    await expect(
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([prompt]);
    await ackScheduledCloudflareSessionPrompt(storage, prompt);
    await expect(
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([]);
    await expect(
      host.store.notifications.claimByIdempotencyKey(idempotencyKey)
    ).resolves.toMatchObject({ ok: true });
  });

  it("keeps durable runtime review fixes locked", async () => {
    const runnerSource = readText(
      "packages/runtime/src/subagent-background-runner.ts"
    );
    const resumeSource = readText("packages/runtime/src/agent-resume.ts");
    const { InMemoryCloudflareDurableObjectStorage } = await import(
      "../examples/cloudflare-edge-subagent/src/cloudflare-host.ts"
    );
    const { DurableObjectSessionStore } = await import(
      "../examples/cloudflare-edge-subagent/src/durable-object-session-store.ts"
    );

    class CountingTransactionStorage extends InMemoryCloudflareDurableObjectStorage {
      transactionCount = 0;

      async transaction(fn) {
        this.transactionCount += 1;
        return await super.transaction(fn);
      }
    }

    const storage = new CountingTransactionStorage();
    const sessions = new DurableObjectSessionStore(storage);

    await sessions.commit(
      "session:review",
      { state: { persisted: true } },
      { expectedVersion: null }
    );

    expect(storage.transactionCount).toBe(1);
    expect(runnerSource).toContain("const durableCancelPollMs = 250;");
    expect(runnerSource).not.toContain("const durableCancelPollMs = 25;");
    expect(resumeSource).toContain("}).finally(() => {");
    expect(resumeSource).toContain("job.settled = true;");
  });
});
