import { describe, expect, it } from "vitest";
import { agentNamespace } from "../../agent/identity/namespace";
import { createInMemoryExecutionHost } from "../memory";
import { dispatchAgentNotification } from "./notification-dispatch";

describe("dispatchAgentNotification", () => {
  it("creates and schedules an idempotent notification run", async () => {
    const host = createInMemoryExecutionHost();

    const first = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired", type: "user-text" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });
    const second = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired again", type: "user-text" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    expect(first).toMatchObject({
      deduplicated: false,
      idempotencyKey: "reminder:1",
    });
    expect(second).toEqual({ ...first, deduplicated: true });
    const run = await host.store.runs.get(first.runId);
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
      input: { text: "Reminder fired", type: "user-text" },
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
      input: { text: "Agent A reminder", type: "user-text" },
      namespace: "agent-a",
      threadKey: "room:1:user:1",
    });
    const second = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:shared",
      input: { text: "Agent B reminder", type: "user-text" },
      namespace: "agent-b",
      threadKey: "room:1:user:2",
    });
    const duplicateFirst = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:shared",
      input: { text: "ignored duplicate", type: "user-text" },
      namespace: "agent-a",
      threadKey: "room:1:user:1",
    });

    expect(second.deduplicated).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect(duplicateFirst).toEqual({ ...first, deduplicated: true });
    await expect(host.store.runs.get(first.runId)).resolves.toMatchObject({
      ownerNamespace: agentNamespace("agent-a"),
      threadKey: "room:1:user:1",
    });
    await expect(host.store.runs.get(second.runId)).resolves.toMatchObject({
      ownerNamespace: agentNamespace("agent-b"),
      threadKey: "room:1:user:2",
    });
  });
});
