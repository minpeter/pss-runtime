import { describe, expect, it } from "vitest";
import { agentNamespace } from "../../agent/identity/namespace";
import { createInMemoryExecutionHost } from "../../platform/memory";
import { isRuntimeAttachmentData } from "../../thread/input/attachments";
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

  it("stages notification file bytes before durable enqueue", async () => {
    const host = createInMemoryExecutionHost();
    const dispatched = await dispatchAgentNotification({
      host,
      idempotencyKey: "attachment:1",
      input: {
        content: [
          { text: "look", type: "text" },
          {
            data: new Uint8Array([1, 2, 3]),
            filename: "photo.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
        type: "user-input",
      },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    const run = await host.store.turns.get(dispatched.runId);
    const notification = await host.store.notifications.getByIdempotencyKey(
      run?.dedupeKey ?? ""
    );

    expect(JSON.stringify(notification)).toContain("pss-attachment:");
    expect(JSON.stringify(notification)).not.toContain('"0":1');
    if (!(notification && "content" in notification.input)) {
      throw new Error("expected multipart notification input");
    }
    const filePart = notification.input.content[1];
    expect(filePart?.type).toBe("file");
    if (filePart?.type !== "file") {
      throw new Error("expected staged file part");
    }
    expect(isRuntimeAttachmentData(filePart.data)).toBe(true);
  });

  it("stages notification observer event file bytes before durable enqueue", async () => {
    const host = createInMemoryExecutionHost();
    const dispatched = await dispatchAgentNotification({
      host,
      idempotencyKey: "attachment-observer:1",
      input: { text: "wake", type: "user-input" },
      namespace: "agent-a",
      observerEvents: [
        {
          content: [
            {
              data: new Uint8Array([7, 8, 9]),
              filename: "context.png",
              mediaType: "image/png",
              type: "file",
            },
          ],
          type: "user-input",
        },
      ],
      threadKey: "room:1:user:2",
    });

    const run = await host.store.turns.get(dispatched.runId);
    const notification = await host.store.notifications.getByIdempotencyKey(
      run?.dedupeKey ?? ""
    );

    expect(JSON.stringify(notification)).toContain("pss-attachment:");
    expect(JSON.stringify(notification)).not.toContain('"0":7');
    const observerEvent = notification?.observerEvents?.[0];
    if (observerEvent?.type !== "user-input" || !("content" in observerEvent)) {
      throw new Error("expected staged multipart observer event");
    }
    const filePart = observerEvent.content[0];
    expect(filePart?.type).toBe("file");
    if (filePart?.type !== "file") {
      throw new Error("expected staged observer file part");
    }
    expect(isRuntimeAttachmentData(filePart.data)).toBe(true);
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
          inputs: host.store.inputs,
          notifications: host.store.notifications,
          checkpoints: host.store.checkpoints,
          threads: host.store.threads,
          turns: runs,
        }),
    },
  };
}
