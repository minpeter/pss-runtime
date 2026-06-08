import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent";
import { agentNamespace } from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, RunRecord } from "./execution/types";
import type { AgentRun } from "./session/run";
import { collectAgentRun } from "./subagent-background-test-support";
import { assistantMessage, eventTypes, userText } from "./test-fixtures";

describe("host notification resume", () => {
  it("host resumes parent notification run once without direct prompt resume surface", async () => {
    const host = createInMemoryExecutionHost();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      host,
      model: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("NOTIFIED")]);
      },
      namespace: "notify-owner",
    });
    const notification = {
      idempotencyKey: "background-complete:bg_1",
      input: userText("background task bg_1 is ready"),
      notificationId: "notification-1",
      observerEvents: [
        {
          eventCount: 1,
          status: "completed",
          subagent: "researcher",
          task_id: "bg_1",
          type: "subagent-job-end",
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

    const events = await collectAgentRun(run);
    expect(eventTypes(events)).toEqual([
      "subagent-job-end",
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
      model: () => Promise.resolve([assistantMessage("OWNER NOTIFIED")]),
      namespace: "owner",
    });
    const attacker = new Agent({
      host,
      model: () => Promise.resolve([assistantMessage("ATTACKER NOTIFIED")]),
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
      model: () => Promise.resolve([assistantMessage("NOTIFIED")]),
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
      model: () => {
        calls += 1;
        return Promise.resolve([assistantMessage("RECOVERED")]);
      },
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

    expect(eventTypes(await collectAgentRun(run))).toContain("assistant-text");
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
      model: () => Promise.resolve([assistantMessage("UNREACHABLE")]),
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

interface ResumableAgent {
  resume(runId: string): Promise<AgentRun | null>;
}

function expectResumeSurface(agent: unknown): asserts agent is ResumableAgent {
  expect(
    getProperty(agent, "resume"),
    "agent resume path is not available"
  ).toBeTypeOf("function");
}

function getProperty(value: unknown, property: "resume"): unknown {
  if (typeof value !== "object" || value === null) {
    return;
  }

  return property in value ? value[property] : undefined;
}

function createSessionLoadFailingHost(): ExecutionHost {
  const base = createInMemoryExecutionHost();
  return {
    ...base,
    store: {
      ...base.store,
      sessions: {
        commit: base.store.sessions.commit.bind(base.store.sessions),
        delete: base.store.sessions.delete.bind(base.store.sessions),
        load: () => Promise.reject(new Error("session load failed")),
      },
    },
  };
}

function notificationRunRecord({
  idempotencyKey,
  ownerNamespace = agentNamespace("notify-owner"),
  runId,
}: {
  readonly idempotencyKey: string;
  readonly ownerNamespace?: string;
  readonly runId: string;
}): RunRecord {
  return {
    checkpointVersion: 0,
    dedupeKey: idempotencyKey,
    kind: "notification",
    ownerNamespace,
    rootRunId: runId,
    runId,
    sessionKey: "default",
    status: "queued",
  };
}
