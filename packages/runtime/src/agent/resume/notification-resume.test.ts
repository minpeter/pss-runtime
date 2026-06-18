import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "../../execution/memory";
import { collect } from "../../session/handle/test-support";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { Agent } from "../core/agent";
import { agentNamespace } from "../identity/namespace";
import {
  createSessionLoadFailingHost,
  expectResumeSurface,
  notificationRunRecord,
} from "./notification-resume.test-support";

describe("host notification resume", () => {
  it("host resumes parent notification run once without direct prompt resume surface", async () => {
    const host = createInMemoryExecutionHost();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      host,
      model: createCallbackModel(({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("NOTIFIED")]);
      }),
      namespace: "notify-owner",
    });
    const notification = {
      idempotencyKey: "background-complete:bg_1",
      input: userText("background task bg_1 is ready"),
      notificationId: "notification-1",
      observerEvents: [
        {
          text: "background task bg_1 completed",
          type: "assistant-reasoning",
        },
      ],
      ownerNamespace: agentNamespace("notify-owner"),
      runId: "notification-run-1",
      sessionKey: "default",
      status: "pending",
    } as const;
    await host.store.notifications.enqueue(notification);
    await host.store.runs.create(
      notificationRunRecord({
        idempotencyKey: notification.idempotencyKey,
        runId: notification.runId,
      })
    );
    expectResumeSurface(agent);

    const run = await agent.resume(notification.runId);
    expect(run).not.toBeNull();
    if (!run) {
      throw new Error("Expected notification resume to return a run.");
    }

    const events = await collect(run);
    expect(eventTypes(events)).toEqual([
      "assistant-reasoning",
      "turn-start",
      "runtime-input",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(seenHistory).toHaveLength(1);
    expect(JSON.stringify(seenHistory[0])).toContain("bg_1");

    const duplicateRun = await agent.resume(notification.runId);
    expect(duplicateRun).toBeNull();
    expect(calls).toBe(1);
  });

  it("does not let another agent claim a foreign notification", async () => {
    const host = createInMemoryExecutionHost();
    const owner = new Agent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("OWNER NOTIFIED")])
      ),
      namespace: "owner",
    });
    const attacker = new Agent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("ATTACKER NOTIFIED")])
      ),
      namespace: "attacker",
    });
    const notification = {
      idempotencyKey: "background-complete:default:bg_foreign",
      input: userText("background task bg_foreign is ready"),
      notificationId: "notification-foreign",
      ownerNamespace: agentNamespace("owner"),
      runId: "notification-run-foreign",
      sessionKey: "default",
      status: "pending",
    } as const;
    await host.store.notifications.enqueue(notification);
    await host.store.runs.create(
      notificationRunRecord({
        idempotencyKey: notification.idempotencyKey,
        ownerNamespace: agentNamespace("owner"),
        runId: notification.runId,
      })
    );

    await expect(attacker.resume(notification.runId)).resolves.toBeNull();
    await expect(
      host.store.notifications.getByIdempotencyKey(notification.idempotencyKey)
    ).resolves.toEqual(expect.objectContaining({ status: "pending" }));

    await expect(owner.resume(notification.runId)).resolves.not.toBeNull();
  });

  it("keeps notification pending when session resume is not accepted", async () => {
    const host = createSessionLoadFailingHost();
    const agent = new Agent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("NOTIFIED")])
      ),
      namespace: "notify-owner",
    });
    const notification = {
      idempotencyKey: "background-complete:bg_retry",
      input: userText("background task bg_retry is ready"),
      notificationId: "notification-retry",
      ownerNamespace: agentNamespace("notify-owner"),
      runId: "notification-run-retry",
      sessionKey: "default",
      status: "pending",
    } as const;
    await host.store.notifications.enqueue(notification);
    await host.store.runs.create(
      notificationRunRecord({
        idempotencyKey: notification.idempotencyKey,
        runId: notification.runId,
      })
    );

    await expect(agent.resume(notification.runId)).rejects.toThrow(
      "session load failed"
    );
    await expect(
      host.store.notifications.getByIdempotencyKey(notification.idempotencyKey)
    ).resolves.toEqual(expect.objectContaining({ status: "pending" }));
  });

  it("resumes an acked notification when durable run retry owns the lease", async () => {
    const host = createInMemoryExecutionHost();
    let calls = 0;
    const agent = new Agent({
      host,
      model: createCallbackModel(() => {
        calls += 1;
        return Promise.resolve([assistantMessage("RECOVERED")]);
      }),
      namespace: "notify-owner",
    });
    const idempotencyKey = "background-complete:bg_recover";
    const runId = "notification-run-recover";
    await host.store.notifications.enqueue({
      idempotencyKey,
      input: userText("background task bg_recover is ready"),
      notificationId: "notification-recover",
      ownerNamespace: agentNamespace("notify-owner"),
      runId,
      sessionKey: "default",
      status: "acked",
    });
    await host.store.runs.create(
      notificationRunRecord({ idempotencyKey, runId })
    );

    const run = await agent.resume(runId);
    expect(run).not.toBeNull();
    if (!run) {
      throw new Error("Expected notification resume retry to return a run.");
    }

    expect(eventTypes(await collect(run))).toContain("assistant-text");
    await expect(
      host.store.notifications.getByIdempotencyKey(idempotencyKey)
    ).resolves.toEqual(expect.objectContaining({ status: "acked" }));
    await expect(host.store.runs.get(runId)).resolves.toEqual(
      expect.objectContaining({ status: "completed" })
    );
    expect(calls).toBe(1);
  });

  it("does not complete durable notification run when payload is unavailable", async () => {
    const host = createInMemoryExecutionHost();
    const agent = new Agent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("UNREACHABLE")])
      ),
      namespace: "notify-owner",
    });
    const idempotencyKey = "background-complete:bg_missing";
    const runId = "notification-run-missing";
    await host.store.runs.create(
      notificationRunRecord({ idempotencyKey, runId })
    );

    await expect(agent.resume(runId)).resolves.toBeNull();
    await expect(host.store.runs.get(runId)).resolves.toEqual(
      expect.objectContaining({ status: "leased" })
    );
  });
});
