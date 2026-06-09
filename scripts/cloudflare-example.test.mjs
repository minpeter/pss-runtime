import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const legacyCloudflareSessionKeyPattern =
  /`\$\{this\.#prefix\}:\$\{encodeURIComponent\(key\)\}`/;
const removedTurnModeEnvName = ["PSS", "TURN", "MODE"].join("_");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

describe("cloudflare edge support subagent example", () => {
  it("uses a Cloudflare Worker/Durable Object adapter surface", () => {
    const packageJson = readJson(
      "examples/cloudflare-edge-subagent/package.json"
    );
    const source = readText("examples/cloudflare-edge-subagent/src/index.ts");
    const hostSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-host.ts"
    );
    const storeSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-execution-store.ts"
    );
    const workerSource = readText(
      "examples/cloudflare-edge-subagent/src/worker.ts"
    );
    const workerRouteSource = readText(
      "examples/cloudflare-edge-subagent/src/worker-route.ts"
    );
    const alarmDrainerSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-alarm-drainer.ts"
    );
    const alarmWorkSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-alarm-work.ts"
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
    expect(source).toContain("@minpeter/pss-runtime/cloudflare");
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
    expect(alarmWorkSource).toContain("agent.resume(");
    expect(alarmWorkSource).toContain("ackScheduledCloudflareRun");
    expect(alarmDrainerSource).toContain("rescheduleCloudflareAlarm");
    expect(hostSource).toContain("setAlarm");
    expect(workerTsconfig.compilerOptions.types).toEqual([
      "@cloudflare/workers-types",
    ]);
    const sessionStoreSource = readText(
      "packages/runtime/src/cloudflare/durable-object-session-store.ts"
    );
    expect(sessionStoreSource).toContain('storeKey(this.#prefix, "session"');
    expect(sessionStoreSource).not.toMatch(legacyCloudflareSessionKeyPattern);
  });

  it("keeps the Cloudflare example as a runtime adapter consumer", () => {
    const source = readText("examples/cloudflare-edge-subagent/src/index.ts");
    const workerSource = readText(
      "examples/cloudflare-edge-subagent/src/worker.ts"
    );
    const simulationSource = readText(
      "examples/cloudflare-edge-subagent/src/worker-simulation.ts"
    );
    const edgeCasesSource = readText(
      "examples/cloudflare-edge-subagent/src/worker-edge-cases.ts"
    );
    const combinedSource = [
      source,
      workerSource,
      simulationSource,
      edgeCasesSource,
    ].join("\n");
    const movedAdapterFiles = [
      "cloudflare-alarm-drainer.ts",
      "cloudflare-checkpoint-store.ts",
      "cloudflare-event-store.ts",
      "cloudflare-execution-session-store.ts",
      "cloudflare-execution-store.ts",
      "cloudflare-host.ts",
      "cloudflare-notification-store.ts",
      "cloudflare-run-store.ts",
      "cloudflare-store-utils.ts",
      "durable-object-session-store.ts",
      "durable-object-storage.ts",
    ];

    expect(combinedSource).toContain("@minpeter/pss-runtime/cloudflare");
    expect(combinedSource).not.toContain('from "./cloudflare-host"');
    expect(combinedSource).not.toContain('from "./cloudflare-alarm-drainer"');
    for (const fileName of movedAdapterFiles) {
      expect(
        existsSync(`examples/cloudflare-edge-subagent/src/${fileName}`)
      ).toBe(false);
    }
  });

  it("drives Cloudflare scheduled runs and session prompts through stored alarms", async () => {
    const {
      InMemoryCloudflareDurableObjectStorage,
      ackScheduledCloudflareRun,
      ackScheduledCloudflareSessionPrompt,
      createCloudflareDurableObjectHost,
      listScheduledCloudflareRuns,
      listScheduledCloudflareSessionPrompts,
    } = await import("../packages/runtime/src/cloudflare/index.ts");
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
    const resumeSource = readText(
      "packages/runtime/src/background-child-resume.ts"
    );
    const { InMemoryCloudflareDurableObjectStorage } = await import(
      "../packages/runtime/src/cloudflare/index.ts"
    );
    const { DurableObjectSessionStore } = await import(
      "../packages/runtime/src/cloudflare/durable-object-session-store.ts"
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
