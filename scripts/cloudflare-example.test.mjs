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
    const sessionStoreSource = readText(
      "packages/runtime/src/cloudflare/storage/sqlite/session-store.ts"
    );

    expect(hostSource).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(hostSource).toContain("createCloudflareDurableObjectHost");
    expect(hostSource).toContain("createCloudflareAlarmScheduler");
    expect(hostSource).toContain("setAlarm");
    expect(storeSource).toContain("DurableObjectExecutionStore");
    expect(storeSource).toContain("DurableObjectSqliteSessionStore");
    expect(alarmWorkSource).toContain("agent.resume(");
    expect(alarmWorkSource).toContain("ackScheduledCloudflareRun");
    expect(alarmDrainerSource).toContain("rescheduleCloudflareAlarm");
    expect(sessionStoreSource).toContain("pss_session_meta");
  });

  it("drives Cloudflare scheduled runs and session prompts through stored alarms", async () => {
    const { InMemorySqlStorage } = await import(
      "../packages/runtime/src/cloudflare/sql/node-test/node-sqlite-storage.ts"
    );
    const {
      InMemoryCloudflareDurableObjectStorage,
      ackScheduledCloudflareRun,
      ackScheduledCloudflareSessionPrompt,
      createCloudflareDurableObjectHost,
      listScheduledCloudflareRuns,
      listScheduledCloudflareSessionPrompts,
    } = await import("../packages/runtime/src/cloudflare/index.ts");
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
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

  it("stores Durable Object sessions in SQLite rows", async () => {
    const { InMemorySqlStorage } = await import(
      "../packages/runtime/src/cloudflare/sql/node-test/node-sqlite-storage.ts"
    );
    const { DurableObjectSqliteSessionStore } = await import(
      "../packages/runtime/src/cloudflare/storage/sqlite/session-store.ts"
    );
    const { InMemoryCloudflareDurableObjectStorage } = await import(
      "../packages/runtime/src/cloudflare/index.ts"
    );

    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const sessions = new DurableObjectSqliteSessionStore(storage, "script");

    await sessions.commit(
      "session:review",
      {
        state: { history: [{ role: "user", content: "hi" }], schemaVersion: 1 },
      },
      { expectedVersion: null }
    );

    await expect(sessions.load("session:review")).resolves.toEqual({
      state: { history: [{ role: "user", content: "hi" }], schemaVersion: 1 },
      version: "1",
    });
  });
});
