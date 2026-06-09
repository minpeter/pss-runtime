import { describe, expect, it } from "vitest";
import { agentNamespace } from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { NotificationRecord } from "./execution/types";
import { userText } from "./test-fixtures";

describe("NotificationInbox", () => {
  it("dedupes duplicate completion notification claims by key", async () => {
    const host = createInMemoryExecutionHost();
    const record = createNotificationRecord();

    await expect(host.store.notifications.enqueue(record)).resolves.toEqual({
      ok: true,
    });

    const firstClaim = await host.store.notifications.claimByIdempotencyKey(
      record.idempotencyKey
    );
    expect(firstClaim).toEqual({
      ok: true,
      record: expect.objectContaining({
        idempotencyKey: record.idempotencyKey,
        status: "pending",
      }),
    });
    await expect(
      host.store.notifications.getByIdempotencyKey(record.idempotencyKey)
    ).resolves.toEqual(expect.objectContaining({ status: "acked" }));

    const duplicateClaim = await host.store.notifications.claimByIdempotencyKey(
      record.idempotencyKey
    );
    expect(duplicateClaim).toEqual({
      ok: false,
      reason: "already-claimed",
      record: expect.objectContaining({ status: "acked" }),
    });
  });

  it("dedupes duplicate pending notification enqueue by key", async () => {
    const host = createInMemoryExecutionHost();
    const record = createNotificationRecord();

    await expect(host.store.notifications.enqueue(record)).resolves.toEqual({
      ok: true,
    });
    await expect(host.store.notifications.enqueue(record)).resolves.toEqual({
      existingNotificationId: record.notificationId,
      ok: false,
      reason: "duplicate",
    });
  });
});

function createNotificationRecord(): NotificationRecord {
  return {
    idempotencyKey: "background-complete:bg_1",
    input: userText("background task bg_1 is ready"),
    notificationId: "notification-1",
    ownerNamespace: agentNamespace("notify-owner"),
    runId: "notification-run-1",
    sessionKey: "default",
    status: "pending",
  };
}
