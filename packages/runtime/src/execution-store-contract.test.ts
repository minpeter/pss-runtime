import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import type {
  CheckpointWriteResult,
  ExecutionStore,
  RunRecord,
  StoredAgentEvent,
} from "./execution/types";

const createQueuedRun = (runId = "run-1"): RunRecord => ({
  checkpointVersion: 0,
  kind: "user-turn",
  rootRunId: runId,
  runId,
  sessionKey: "session-1",
  status: "queued",
});

const collectEvents = async (
  events: AsyncIterable<StoredAgentEvent>
): Promise<StoredAgentEvent[]> => {
  const collected: StoredAgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
};

describe("ExecutionStore contract", () => {
  it("transactions commit run checkpoint event and notification atomically", async () => {
    const host = createInMemoryExecutionHost();

    await host.store.transaction(async (tx) => {
      await tx.runs.create(createQueuedRun());
      const checkpointResult = await tx.checkpoints.append(
        {
          checkpointId: "checkpoint-1",
          phase: "before-model",
          runId: "run-1",
          runtimeState: { step: 1 },
          sessionSnapshot: { messages: [] },
          version: 1,
        },
        { expectedVersion: 0 }
      );
      await tx.events.append("run-1", { type: "turn-start" });
      await tx.notifications.enqueue({
        idempotencyKey: "notify-1",
        input: { text: "ready", type: "user-text" },
        notificationId: "notification-1",
        runId: "run-1",
        sessionKey: "session-1",
        status: "pending",
      });
      await tx.sessions.commit(
        "session-1",
        { state: { messages: ["committed transaction"] } },
        { expectedVersion: null }
      );

      expect(checkpointResult).toEqual({ ok: true, version: 1 });
    });

    await expect(host.store.runs.get("run-1")).resolves.toMatchObject({
      runId: "run-1",
      status: "queued",
    });
    await expect(host.store.checkpoints.latest("run-1")).resolves.toMatchObject(
      {
        checkpointId: "checkpoint-1",
        version: 1,
      }
    );
    expect(await collectEvents(host.store.events.read("run-1"))).toHaveLength(
      1
    );
    await expect(
      host.store.notifications.getByIdempotencyKey("notify-1")
    ).resolves.toMatchObject({
      notificationId: "notification-1",
    });
    await expect(host.store.sessions.load("session-1")).resolves.toMatchObject({
      state: { messages: ["committed transaction"] },
      version: "1",
    });
  });

  it("rolls back transaction writes when the transaction fails", async () => {
    const host = createInMemoryExecutionHost();

    await expect(
      host.store.transaction(async (tx) => {
        await tx.runs.create(createQueuedRun());
        throw new Error("transaction failed");
      })
    ).rejects.toThrow("transaction failed");

    await expect(host.store.runs.get("run-1")).resolves.toBeNull();
  });

  it("rolls back transaction session writes when the transaction fails", async () => {
    const host = createInMemoryExecutionHost();

    await expect(
      host.store.transaction(async (tx) => {
        await tx.sessions.commit(
          "session-1",
          { state: { messages: ["inside transaction"] } },
          { expectedVersion: null }
        );
        throw new Error("transaction failed");
      })
    ).rejects.toThrow("transaction failed");

    await expect(host.store.sessions.load("session-1")).resolves.toBeNull();
  });

  it("serializes concurrent transactions", async () => {
    const host = createInMemoryExecutionHost();
    const firstStarted = createDeferred();
    const firstCanFinish = createDeferred();
    let secondSettled = false;

    const first = host.store.transaction(async (tx) => {
      await tx.runs.create(createQueuedRun("run-serial"));
      firstStarted.resolve();
      await firstCanFinish.promise;
    });
    await firstStarted.promise;
    const second = host.store
      .transaction(async (tx) => {
        const run = await tx.runs.get("run-serial");
        if (!run) {
          throw new Error("Expected first transaction to commit first.");
        }
        await tx.runs.update({ ...run, status: "cancelled" });
      })
      .then(() => {
        secondSettled = true;
      });

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    firstCanFinish.resolve();
    await Promise.all([first, second]);

    await expect(host.store.runs.get("run-serial")).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("rejects duplicate active run claims", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.runs.create(createQueuedRun());

    await expect(
      host.store.runs.claim("run-1", {
        attempt: 1,
        leaseId: "lease-1",
        leaseMs: 100,
        nowMs: 0,
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.store.runs.claim("run-1", {
        attempt: 2,
        leaseId: "lease-2",
        leaseMs: 100,
        nowMs: 50,
      })
    ).resolves.toEqual({ ok: false, reason: "leased" });
  });

  it("rejects stale checkpoint writes", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.runs.create(createQueuedRun());

    const first = await appendCheckpoint(host.store, 0);
    const stale = await appendCheckpoint(host.store, 0);

    expect(first).toEqual({ ok: true, version: 1 });
    expect(stale).toEqual({
      currentVersion: 1,
      ok: false,
      reason: "stale-version",
    });
  });

  it("replays events from a cursor without duplicates", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.runs.create(createQueuedRun());

    const firstCursor = await host.store.events.append("run-1", {
      type: "turn-start",
    });
    await host.store.events.append("run-1", { type: "turn-end" });

    const replayed = await collectEvents(
      host.store.events.read("run-1", firstCursor)
    );

    expect(replayed).toEqual([
      {
        cursor: { offset: 2 },
        event: { type: "turn-end" },
        runId: "run-1",
      },
    ]);
  });

  it("dedupes notifications by idempotency key", async () => {
    const host = createInMemoryExecutionHost();
    const input = { text: "ready", type: "user-text" } as const;

    await expect(
      host.store.notifications.enqueue({
        idempotencyKey: "notify-1",
        input,
        notificationId: "notification-1",
        runId: "run-1",
        sessionKey: "session-1",
        status: "pending",
      })
    ).resolves.toEqual({ ok: true });
    await expect(
      host.store.notifications.enqueue({
        idempotencyKey: "notify-1",
        input,
        notificationId: "notification-2",
        runId: "run-1",
        sessionKey: "session-1",
        status: "pending",
      })
    ).resolves.toEqual({
      existingNotificationId: "notification-1",
      ok: false,
      reason: "duplicate",
    });
  });
});

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function appendCheckpoint(
  store: ExecutionStore,
  expectedVersion: number
): Promise<CheckpointWriteResult> {
  return await store.checkpoints.append(
    {
      checkpointId: `checkpoint-${expectedVersion + 1}`,
      phase: "before-model",
      runId: "run-1",
      runtimeState: {},
      sessionSnapshot: {},
      version: expectedVersion + 1,
    },
    { expectedVersion }
  );
}
