import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const legacyCloudflareSessionKeyPattern =
  /`\$\{this\.#prefix\}:\$\{encodeURIComponent\(key\)\}`/;

function readText(path) {
  return readFileSync(path, "utf8");
}

describe("cloudflare durable object adapter", () => {
  it("exposes the packaged Worker/Durable Object adapter surface", () => {
    const hostSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-host.ts"
    );
    const storeSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-execution-store.ts"
    );
    const alarmDrainerSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-alarm-drainer.ts"
    );
    const alarmWorkSource = readText(
      "packages/runtime/src/cloudflare/cloudflare-alarm-work.ts"
    );
    const sessionStoreSource = readText(
      "packages/runtime/src/cloudflare/durable-object-session-store.ts"
    );

    expect(hostSource).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(hostSource).toContain("createCloudflareDurableObjectHost");
    expect(hostSource).toContain("createCloudflareAlarmScheduler");
    expect(hostSource).toContain("setAlarm");
    expect(storeSource).toContain("DurableObjectExecutionStore");
    expect(alarmWorkSource).toContain("agent.resume(");
    expect(alarmWorkSource).toContain("ackScheduledCloudflareRun");
    expect(alarmDrainerSource).toContain("rescheduleCloudflareAlarm");
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