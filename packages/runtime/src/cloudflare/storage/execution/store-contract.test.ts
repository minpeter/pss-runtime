import { describe, expect, it } from "vitest";
import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import type { NotificationRecord, RunRecord } from "../../../execution";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "./records";
import { DurableObjectExecutionStore } from "./store";

describeExecutionStoreContract({
  createStore: () =>
    new DurableObjectExecutionStore({
      prefix: "contract-test",
      storage: new InMemoryCloudflareDurableObjectStorage(),
    }),
  name: "DurableObjectExecutionStore",
});

describe("DurableObjectExecutionStore payload guards", () => {
  it("rejects notification records that exceed the serialized payload budget", async () => {
    const store = createBudgetedStore(220);

    await expect(
      store.notifications.enqueue({
        idempotencyKey: "notify-big",
        input: { text: "x".repeat(300), type: "user-text" },
        notificationId: "notification-big",
        runId: "run-1",
        threadKey: "thread-1",
        status: "pending",
      })
    ).rejects.toMatchObject({
      byteLength: expect.any(Number),
      maxBytes: 220,
      payloadKind: "notification-record",
    });
    await expect(
      store.notifications.getByIdempotencyKey("notify-big")
    ).resolves.toBeNull();
  });

  it("rejects run records on create when they exceed the serialized payload budget", async () => {
    const store = createBudgetedStore(180);

    await expect(
      store.runs.create(
        runRecord("run-create", { output: { notes: "x".repeat(240) } })
      )
    ).rejects.toMatchObject({
      byteLength: expect.any(Number),
      maxBytes: 180,
      payloadKind: "run-record",
    });
    await expect(store.runs.get("run-create")).resolves.toBeNull();
  });

  it("rejects run records on update when they exceed the serialized payload budget", async () => {
    const store = createBudgetedStore(180);
    await store.runs.create(runRecord("run-update"));

    await expect(
      store.runs.update(
        runRecord("run-update", { output: { notes: "x".repeat(240) } })
      )
    ).rejects.toMatchObject({
      byteLength: expect.any(Number),
      maxBytes: 180,
      payloadKind: "run-record",
    });
    await expect(store.runs.get("run-update")).resolves.toEqual(
      runRecord("run-update")
    );
  });

  it("stores run records in SQLite rows instead of Durable Object KV values", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      prefix: "run-sql-test",
      storage,
    });
    const record = runRecord("run-sql", {
      dedupeKey: "dedupe-1",
      parentRunId: "parent-1",
    });

    await store.runs.create(record);

    const rows = (storage.sql as InMemorySqlStorage)
      .exec<{ readonly record: string }>(
        "SELECT record FROM pss_run WHERE prefix = ? AND run_id = ?",
        "run-sql-test",
        "run-sql"
      )
      .toArray();
    expect(rows.map((row) => JSON.parse(row.record))).toEqual([record]);
    await expect(
      storage.get(storeKey("run-sql-test", "run", "run-sql"))
    ).resolves.toBeUndefined();
    await expect(store.runs.getByDedupeKey("dedupe-1")).resolves.toEqual(
      record
    );
    await expect(store.runs.listByParentRunId("parent-1")).resolves.toEqual([
      record,
    ]);
  });

  it("stores notification records in SQLite rows instead of Durable Object KV values", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      prefix: "notification-sql-test",
      storage,
    });
    const record = notificationRecord("notify-sql");

    await expect(store.notifications.enqueue(record)).resolves.toEqual({
      ok: true,
    });

    const rows = (storage.sql as InMemorySqlStorage)
      .exec<{ readonly record: string }>(
        "SELECT record FROM pss_notification WHERE prefix = ? AND idempotency_key = ?",
        "notification-sql-test",
        "notify-sql"
      )
      .toArray();
    expect(rows.map((row) => JSON.parse(row.record))).toEqual([record]);
    await expect(
      storage.get(
        storeKey("notification-sql-test", "notification", "notify-sql")
      )
    ).resolves.toBeUndefined();
  });

  it("migrates legacy notification KV records to SQLite rows when claimed by idempotency key", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      prefix: "notification-migration-test",
      storage,
    });
    const legacy = notificationRecord("notify-legacy");
    await storage.put(
      storeKey("notification-migration-test", "notification", "notify-legacy"),
      legacy
    );

    await expect(
      store.notifications.claimByIdempotencyKey("notify-legacy")
    ).resolves.toEqual({
      ok: true,
      record: { ...legacy, status: "acked" },
    });

    const rows = (storage.sql as InMemorySqlStorage)
      .exec<{ readonly record: string }>(
        "SELECT record FROM pss_notification WHERE prefix = ? AND idempotency_key = ?",
        "notification-migration-test",
        "notify-legacy"
      )
      .toArray();
    expect(rows.map((row) => JSON.parse(row.record))).toEqual([
      { ...legacy, status: "acked" },
    ]);
    await expect(
      storage.get(
        storeKey("notification-migration-test", "notification", "notify-legacy")
      )
    ).resolves.toBeUndefined();
  });
});

function createBudgetedStore(
  maxPayloadBytes: number
): DurableObjectExecutionStore {
  return new DurableObjectExecutionStore({
    maxPayloadBytes,
    prefix: "payload-test",
    storage: new InMemoryCloudflareDurableObjectStorage(),
  });
}

function runRecord(
  runId: string,
  overrides: Partial<RunRecord> = {}
): RunRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey: "thread-1",
    status: "queued",
    ...overrides,
  };
}

function notificationRecord(
  idempotencyKey: string,
  overrides: Partial<NotificationRecord> = {}
): NotificationRecord {
  return {
    idempotencyKey,
    input: { text: "wake up", type: "user-text" },
    notificationId: "notification-1",
    runId: "run-1",
    threadKey: "thread-1",
    status: "pending",
    ...overrides,
  };
}
