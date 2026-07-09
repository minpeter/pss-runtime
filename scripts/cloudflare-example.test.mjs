import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readText(path) {
  return readFileSync(path, "utf8");
}

describe("cloudflare durable object adapter", () => {
  it("exposes the packaged Worker/Durable Object adapter surface", () => {
    const hostSource = readText(
      "packages/runtime/src/platform/cloudflare/host/durable-object-host.ts"
    );
    const storeSource = readText(
      "packages/runtime/src/platform/cloudflare/storage/execution/store.ts"
    );
    const platformHostSource = readText(
      "packages/runtime/src/platform/cloudflare/host/create-cloudflare-host.ts"
    );
    const platformContextSource = readText(
      "packages/runtime/src/platform/cloudflare/agents/context.ts"
    );
    const threadStoreSource = readText(
      "packages/runtime/src/platform/cloudflare/storage/sqlite/thread-store.ts"
    );
    const threadStoreSchemaSource = readText(
      "packages/runtime/src/platform/cloudflare/storage/sqlite/thread-store-sql/schema/bootstrap.ts"
    );

    expect(hostSource).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(hostSource).toContain("createCloudflareStorageHost");
    expect(hostSource).toContain("createCloudflareScheduledWorkScheduler");
    expect(hostSource).not.toContain("setAlarm");
    expect(platformHostSource).toContain("createCloudflareHost");
    expect(platformHostSource).toContain("createCloudflareAgentsFiberScheduler");
    expect(platformContextSource).toContain("createCloudflarePlatformContext");
    expect(storeSource).toContain("DurableObjectExecutionStore");
    expect(storeSource).toContain("DurableObjectSqliteThreadStore");
    expect(threadStoreSource).toContain("DurableObjectSqliteThreadStore");
    expect(threadStoreSchemaSource).toContain("pss_thread_meta");
  });

  it("drives Cloudflare scheduled work through the queue-only storage host", async () => {
    const { InMemorySqlStorage } = await import(
      "../packages/runtime/src/platform/cloudflare/sql/node-test/node-sqlite-storage.ts"
    );
    const {
      InMemoryCloudflareDurableObjectStorage,
      ackScheduledCloudflareRun,
      ackScheduledCloudflareThreadPrompt,
      createCloudflareStorageHost,
      listScheduledCloudflareRuns,
      listScheduledCloudflareThreadPrompts,
    } = await import("../packages/runtime/src/platform/cloudflare/index.ts");
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });
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
      input: { text: "ready", type: "user-input" },
      notificationId: "notification-delayed",
      runId: notificationRunId,
      status: "pending",
      threadKey: "example",
    });

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      runId,
    ]);
    await expect(listScheduledCloudflareThreadPrompts(storage)).resolves.toEqual(
      [
        {
          idempotencyKey,
          runId: notificationRunId,
          threadKey: "example",
        },
      ]
    );

    await ackScheduledCloudflareRun(storage, runId);
    await ackScheduledCloudflareThreadPrompt(storage, {
      idempotencyKey,
      runId: notificationRunId,
      threadKey: "example",
    });

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([]);
  });
});
