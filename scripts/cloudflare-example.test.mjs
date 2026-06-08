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

describe("Cloudflare agent worker app", () => {
  it("uses a Cloudflare Worker/Durable Object adapter surface", () => {
    const packageJson = readJson("apps/agent-worker/package.json");
    const source = readText("apps/agent-worker/src/index.ts");
    const hostSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-host.ts"
    );
    const storeSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-execution-store.ts"
    );
    const workerSource = readText("apps/agent-worker/src/worker.ts");
    const workerConstantsSource = readText(
      "apps/agent-worker/src/worker-constants.ts"
    );
    const workerRouteSource = readText("apps/agent-worker/src/worker-route.ts");
    const alarmDrainerSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-alarm-drainer.ts"
    );
    const workerTsconfig = readJson("apps/agent-worker/tsconfig.worker.json");
    const readme = readText("apps/agent-worker/README.md");

    expect(packageJson.scripts["start:worker-sim"]).toBe(
      "tsx --conditions=@minpeter/pss-source src/worker-simulation.ts"
    );
    expect(packageJson.scripts["start:edge-cases"]).toBe(
      "tsx --conditions=@minpeter/pss-source src/worker-edge-cases.ts"
    );
    expect(packageJson.scripts["start:cli"]).toBe(
      "tsx --conditions=@minpeter/pss-source src/index.ts"
    );
    expect(packageJson.scripts["typecheck:worker"]).toBe(
      "tsc -p tsconfig.worker.json --noEmit"
    );
    expect(packageJson.scripts["dev:worker"]).toBe("wrangler dev");
    expect(packageJson.scripts["deploy:worker"]).toBe("wrangler deploy");
    expect(packageJson.scripts["dry-run:worker"]).toBe(
      "wrangler deploy --dry-run --outdir /tmp/pss-agent-worker-dry-run"
    );
    expect(packageJson.scripts["predeploy:worker"]).toBe(
      "pnpm --filter @minpeter/pss-runtime build"
    );
    expect(packageJson.scripts["predev:worker"]).toBe(
      "pnpm --filter @minpeter/pss-runtime build"
    );
    expect(packageJson.scripts["predry-run:worker"]).toBe(
      "pnpm --filter @minpeter/pss-runtime build"
    );
    expect(packageJson.devDependencies.wrangler).toBeDefined();
    expect(source).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(source).not.toContain(removedTurnModeEnvName);
    expect(hostSource).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(readme).not.toContain(removedTurnModeEnvName);
    expect(readme).not.toContain("fake host");
    expect(readme).not.toContain("in-memory fake");
    expect(readme).toContain("@minpeter/pss-agent-worker");
    expect(readme).toContain("durable-background");
    expect(readme).toContain("Durable Object alarms");
    expect(readme).toContain("dev:worker");
    expect(source).toContain("@minpeter/pss-runtime/cloudflare");
    expect(source).toContain(
      'import { workerStorePrefix } from "./worker-constants"'
    );
    expect(workerConstantsSource).toContain('"agent-worker-demo"');
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
      "packages/runtime/src/cloudflare/durable-object-session-store.ts"
    );
    expect(sessionStoreSource).toContain('storeKey(this.#prefix, "session"');
    expect(sessionStoreSource).not.toMatch(legacyCloudflareSessionKeyPattern);
  });

  it("keeps the Cloudflare app as a runtime adapter consumer", () => {
    const appSourceFiles = [
      "apps/agent-worker/src/agent-factory.ts",
      "apps/agent-worker/src/cloudflare-durable.test.ts",
      "apps/agent-worker/src/index.ts",
      "apps/agent-worker/src/stress-edge-scenarios.ts",
      "apps/agent-worker/src/stress-scenarios.ts",
      "apps/agent-worker/src/worker-edge-alarm-checks.ts",
      "apps/agent-worker/src/worker-edge-durable-checks.ts",
      "apps/agent-worker/src/worker-simulation.ts",
      "apps/agent-worker/src/worker.ts",
    ];
    const combinedSource = appSourceFiles.map(readText).join("\n");
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
      expect(existsSync(`apps/agent-worker/src/${fileName}`)).toBe(false);
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
    const resumeSource = readText("packages/runtime/src/agent-resume.ts");
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
