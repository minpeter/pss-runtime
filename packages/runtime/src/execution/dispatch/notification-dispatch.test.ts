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
      sessionKey: "room:1:user:2",
    });
    const second = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired again", type: "user-text" },
      namespace: "agent-a",
      sessionKey: "room:1:user:2",
    });

    expect(first).toMatchObject({
      deduplicated: false,
      idempotencyKey: "reminder:1",
    });
    expect(second).toEqual({ ...first, deduplicated: true });
    await expect(host.store.runs.get(first.runId)).resolves.toMatchObject({
      dedupeKey: "reminder:1",
      kind: "notification",
      ownerNamespace: agentNamespace("agent-a"),
      sessionKey: "room:1:user:2",
      status: "queued",
    });
    await expect(
      host.store.notifications.getByIdempotencyKey("reminder:1")
    ).resolves.toMatchObject({
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired", type: "user-text" },
      ownerNamespace: agentNamespace("agent-a"),
      runId: first.runId,
      sessionKey: "room:1:user:2",
      status: "pending",
    });
  });
});
