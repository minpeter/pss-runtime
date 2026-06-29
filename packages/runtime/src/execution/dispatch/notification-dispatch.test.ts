import { describe, expect, it } from "vitest";
import { agentNamespace } from "../../agent/identity/namespace";
import { createInMemoryExecutionHost } from "../../platform/memory";
import type { ExecutionHost, TurnRecord, TurnStore } from "../host/types";
import { dispatchAgentNotification } from "./notification-dispatch";

describe("dispatchAgentNotification", () => {
  it("creates and schedules an idempotent notification run", async () => {
    const host = createInMemoryExecutionHost();

    const first = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });
    const second = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired again", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    expect(first).toMatchObject({
      deduplicated: false,
      idempotencyKey: "reminder:1",
    });
    expect(second).toEqual({ ...first, deduplicated: true });
    const run = await host.store.turns.get(first.runId);
    expect(run).toMatchObject({
      kind: "notification",
      ownerNamespace: agentNamespace("agent-a"),
      threadKey: "room:1:user:2",
      status: "queued",
    });
    expect(run?.dedupeKey).toEqual(expect.any(String));
    expect(run?.dedupeKey).not.toBe("reminder:1");
    await expect(
      host.store.notifications.getByIdempotencyKey(run?.dedupeKey ?? "")
    ).resolves.toMatchObject({
      idempotencyKey: run?.dedupeKey,
      input: { text: "Reminder fired", type: "user-input" },
      ownerNamespace: agentNamespace("agent-a"),
      runId: first.runId,
      threadKey: "room:1:user:2",
      status: "pending",
    });
  });

  it("dedupes notifications within the same owner instead of globally", async () => {
    const host = createInMemoryExecutionHost();

    const first = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:shared",
      input: { text: "Agent A reminder", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:1",
    });
    const second = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:shared",
      input: { text: "Agent B reminder", type: "user-input" },
      namespace: "agent-b",
      threadKey: "room:1:user:2",
    });
    const duplicateFirst = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:shared",
      input: { text: "ignored duplicate", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:1",
    });

    expect(second.deduplicated).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect(duplicateFirst).toEqual({ ...first, deduplicated: true });
    await expect(host.store.turns.get(first.runId)).resolves.toMatchObject({
      ownerNamespace: agentNamespace("agent-a"),
      threadKey: "room:1:user:1",
    });
    await expect(host.store.turns.get(second.runId)).resolves.toMatchObject({
      ownerNamespace: agentNamespace("agent-b"),
      threadKey: "room:1:user:2",
    });
  });

  it("returns the existing notification when run dedupe wins a create race", async () => {
    const baseHost = createInMemoryExecutionHost();
    const first = await dispatchAgentNotification({
      host: baseHost,
      idempotencyKey: "reminder:race",
      input: { text: "first", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });
    const racingHost = hostWithDuplicateRunCreate(baseHost);

    const duplicate = await dispatchAgentNotification({
      host: racingHost,
      idempotencyKey: "reminder:race",
      input: { text: "duplicate", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    expect(duplicate).toEqual({ ...first, deduplicated: true });
  });
});

function hostWithDuplicateRunCreate(host: ExecutionHost): ExecutionHost {
  const runs = {
    claim: (runId, options) => host.store.turns.claim(runId, options),
    create: async (record: TurnRecord) => {
      const existing = record.dedupeKey
        ? await host.store.turns.getByDedupeKey(record.dedupeKey)
        : await host.store.turns.get(record.runId);
      if (!existing) {
        throw new Error("Expected pre-existing run for duplicate create race.");
      }
      return { ok: false, reason: "duplicate", record: existing } as const;
    },
    get: (runId) => host.store.turns.get(runId),
    getByDedupeKey: (dedupeKey) => host.store.turns.getByDedupeKey(dedupeKey),
    listByParentRunId: (parentRunId) =>
      host.store.turns.listByParentRunId(parentRunId),
    update: (record) => host.store.turns.update(record),
  } satisfies TurnStore;

  return {
    ...host,
    store: {
      ...host.store,
      turns: runs,
      transaction: (callback) =>
        callback({
          events: host.store.events,
          notifications: host.store.notifications,
          checkpoints: host.store.checkpoints,
          threads: host.store.threads,
          turns: runs,
        }),
    },
  };
}
