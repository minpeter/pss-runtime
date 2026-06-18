import { describe, expect, it } from "vitest";
import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import type { RunRecord } from "../../../execution";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
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
