import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "../../execution";
import {
  dispatchCloudflareAgentNotification,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareSessionPrompts,
} from "../index";
import { InMemorySqlStorage } from "../sql/node-test/node-sqlite-storage";

describe("dispatchCloudflareAgentNotification", () => {
  it("creates a notification run with a provided execution host", async () => {
    const host = createInMemoryExecutionHost();

    const dispatched = await dispatchCloudflareAgentNotification({
      host,
      idempotencyKey: "background:ready",
      input: { text: "Background signal", type: "user-text" },
      namespace: "agent-a",
      sessionKey: "room:1:user:2",
    });

    await expect(host.store.runs.get(dispatched.runId)).resolves.toMatchObject({
      kind: "notification",
      runId: dispatched.runId,
      sessionKey: "room:1:user:2",
      status: "queued",
    });
    await expect(
      host.store.notifications.getByIdempotencyKey("background:ready")
    ).resolves.toMatchObject({
      notificationId: dispatched.notificationId,
      runId: dispatched.runId,
    });
  });

  it("creates a notification run and schedules a Durable Object alarm prompt", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });

    const first = await dispatchCloudflareAgentNotification({
      idempotencyKey: "connector:oauth:done",
      input: { text: "Connector OAuth completed", type: "user-text" },
      namespace: "agent-a",
      prefix: "bori-agent",
      sessionKey: "room:1:user:2",
      storage,
    });
    const second = await dispatchCloudflareAgentNotification({
      idempotencyKey: "connector:oauth:done",
      input: { text: "ignored duplicate", type: "user-text" },
      namespace: "agent-a",
      prefix: "bori-agent",
      sessionKey: "room:1:user:2",
      storage,
    });

    expect(second).toEqual({ ...first, deduplicated: true });
    await expect(
      listScheduledCloudflareSessionPrompts(storage, { prefix: "bori-agent" })
    ).resolves.toEqual([
      {
        idempotencyKey: "connector:oauth:done",
        notificationId: first.notificationId,
        runId: first.runId,
        sessionKey: "room:1:user:2",
      },
    ]);
    expect(storage.alarmTime()).toEqual(expect.any(Number));
  });
});
