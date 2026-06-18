import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readText(path) {
  return readFileSync(path, "utf8");
}

describe("cloudflare durable object adapter", () => {
  it("exposes the packaged Worker/Durable Object adapter surface", () => {
    const hostSource = readText(
      "packages/runtime/src/cloudflare/host/durable-object-host.ts"
    );
    const storeSource = readText(
      "packages/runtime/src/cloudflare/storage/execution/store.ts"
    );
    const alarmDrainerSource = readText(
      "packages/runtime/src/cloudflare/alarm/drainer.ts"
    );
    const alarmWorkSource = readText(
      "packages/runtime/src/cloudflare/alarm/scheduled-work.ts"
    );
    const threadStoreSource = readText(
      "packages/runtime/src/cloudflare/storage/sqlite/thread-store.ts"
    );

    expect(hostSource).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(hostSource).toContain("createCloudflareDurableObjectHost");
    expect(hostSource).toContain("createCloudflareAlarmScheduler");
    expect(hostSource).toContain("setAlarm");
    expect(storeSource).toContain("DurableObjectExecutionStore");
    expect(storeSource).toContain("DurableObjectSqliteThreadStore");
    expect(alarmWorkSource).toContain("agent.resume(");
    expect(alarmWorkSource).toContain("ackScheduledCloudflareRun");
    expect(alarmDrainerSource).toContain("rescheduleCloudflareAlarm");
    expect(threadStoreSource).toContain("pss_session_meta");
  });

  it("drives Cloudflare scheduled runs and thread prompts through stored alarms", async () => {
    const { InMemorySqlStorage } = await import(
      "../packages/runtime/src/cloudflare/sql/node-test/node-sqlite-storage.ts"
    );
    const {
      InMemoryCloudflareDurableObjectStorage,
      ackScheduledCloudflareRun,
      ackScheduledCloudflareThreadPrompt,
      createCloudflareDurableObjectHost,
      listScheduledCloudflareRuns,
      listScheduledCloudflareThreadPrompts,
    } = await import("../packages/runtime/src/cloudflare/index.ts");
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });
    const runId = "background:bg_cloudflare_delayed";
    const idempotencyKey = "background-complete:example:bg_delayed";
    const notificationRunId = "notification-run-delayed";

    await host.scheduler.enqueueRun(runId);
    await host.scheduler.resumeThread("example", {
      idempotencyKey,
      runId: notificationRunId,
    });
    await host.store.notifications.enqueue({
      idempotencyKey,
      input: { text: "ready", type: "user-text" },
      notificationId: "notification-delayed",
      runId: notificationRunId,
      status: "pending",
      threadKey: "example",
    });

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      runId,
    ]);
    await ackScheduledCloudflareRun(storage, runId);
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([]);
    const prompt = {
      idempotencyKey,
      runId: notificationRunId,
      threadKey: "example",
    };
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([prompt]);
    await ackScheduledCloudflareThreadPrompt(storage, prompt);
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([]);
    await expect(
      host.store.notifications.claimByIdempotencyKey(idempotencyKey)
    ).resolves.toMatchObject({ ok: true });
  });

  it("stores Durable Object threads in SQLite rows", async () => {
    const { InMemorySqlStorage } = await import(
      "../packages/runtime/src/cloudflare/sql/node-test/node-sqlite-storage.ts"
    );
    const { DurableObjectSqliteThreadStore } = await import(
      "../packages/runtime/src/cloudflare/storage/sqlite/thread-store.ts"
    );
    const { InMemoryCloudflareDurableObjectStorage } = await import(
      "../packages/runtime/src/cloudflare/index.ts"
    );

    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const threads = new DurableObjectSqliteThreadStore(storage, "script");

    await threads.commit(
      "thread:review",
      {
        state: { history: [{ role: "user", content: "hi" }], schemaVersion: 1 },
      },
      { expectedVersion: null }
    );

    await expect(threads.load("thread:review")).resolves.toEqual({
      state: { history: [{ role: "user", content: "hi" }], schemaVersion: 1 },
      version: "1",
    });
  });
});
