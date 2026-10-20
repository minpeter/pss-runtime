import { describe, expect, it } from "vitest";
import { createCelldSqliteTestStorage } from "../../platform/durable-object/celld/celld-sqlite-test-storage";
import {
  createCelldHost,
  listCelldScheduledThreadPrompts,
} from "../../platform/durable-object/celld/host";
import { createInMemoryHost } from "../../platform/memory";
import type { AgentHost, HostStoreTransaction } from "../host/types";
import { dispatchAgentNotification } from "./notification-dispatch";

const NOW_MS = 1000;
const THREAD_KEY = "room:1:user:2";

const notification = (host: AgentHost) => ({
  host,
  idempotencyKey: "reminder:outbox",
  input: { text: "Reminder fired", type: "user-input" } as const,
  namespace: "agent-a",
  threadKey: THREAD_KEY,
});

describe("dispatchAgentNotification transactional scheduling", () => {
  it("leaves the in-memory thread prompt scheduled when the process dies after commit", async () => {
    // Given: an in-memory host whose post-commit scheduling never happens
    const base = createInMemoryHost();
    const host = withPostCommitDeath(base);

    // When: a notification is dispatched
    const dispatched = await dispatchAgentNotification(notification(host));

    // Then: the wake was committed with the queued run
    await expect(base.scheduler.listScheduledThreadPrompts()).resolves.toEqual([
      {
        idempotencyKey: expect.any(String),
        notificationId: dispatched.notificationId,
        runId: dispatched.runId,
        threadKey: THREAD_KEY,
      },
    ]);
  });

  it("schedules no in-memory thread prompt when the dispatch transaction fails", async () => {
    // Given: an in-memory host whose dispatch transaction fails to commit
    const base = createInMemoryHost();
    const host = withFailingCommit(base);

    // When: a notification is dispatched
    const dispatch = dispatchAgentNotification(notification(host));

    // Then: the wake rolled back with the run
    await expect(dispatch).rejects.toThrow("commit failed");
    await expect(base.scheduler.listScheduledThreadPrompts()).resolves.toEqual(
      []
    );
  });

  it("leaves the Celld thread prompt scheduled and alarm armed when the process dies after commit", async () => {
    // Given: a Celld host whose post-commit scheduling never happens
    const storage = createCelldSqliteTestStorage();
    const host = withPostCommitDeath(
      createCelldHost({
        clock: () => NOW_MS,
        state: { storage, waitUntil: () => undefined },
      })
    );

    // When: a notification is dispatched
    const dispatched = await dispatchAgentNotification(notification(host));

    // Then: the prompt and its alarm committed with the queued run
    await expect(
      listCelldScheduledThreadPrompts(storage, { nowMs: NOW_MS })
    ).resolves.toEqual([
      {
        idempotencyKey: expect.any(String),
        notificationId: dispatched.notificationId,
        runId: dispatched.runId,
        threadKey: THREAD_KEY,
      },
    ]);
    await expect(storage.getAlarm()).resolves.toBe(NOW_MS);
  });

  it("schedules no Celld thread prompt or alarm when the dispatch transaction fails", async () => {
    // Given: a Celld host whose dispatch transaction fails to commit
    const storage = createCelldSqliteTestStorage();
    const host = withFailingCommit(
      createCelldHost({
        clock: () => NOW_MS,
        state: { storage, waitUntil: () => undefined },
      })
    );

    // When: a notification is dispatched
    const dispatch = dispatchAgentNotification(notification(host));

    // Then: neither the prompt nor its alarm survived the rollback
    await expect(dispatch).rejects.toThrow("commit failed");
    await expect(
      listCelldScheduledThreadPrompts(storage, { nowMs: NOW_MS })
    ).resolves.toEqual([]);
    await expect(storage.getAlarm()).resolves.toBeNull();
  });
});

function withPostCommitDeath(host: AgentHost): AgentHost {
  return {
    ...host,
    scheduler: {
      enqueueRun: () => Promise.reject(new Error("process died")),
      resumeThread: () => Promise.reject(new Error("process died")),
    },
  };
}

function withFailingCommit(host: AgentHost): AgentHost {
  return {
    ...host,
    store: {
      ...host.store,
      transaction: (callback) =>
        host.store.transaction(async (tx: HostStoreTransaction) => {
          await callback(tx);
          throw new Error("commit failed");
        }),
    },
  };
}
