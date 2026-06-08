import { describe, expect, it } from "vitest";
import { agentNamespace } from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, ResumeSessionOptions } from "./execution/types";
import type { UserInput } from "./session/input";
import type { AgentRun } from "./session/run";
import { notifyBackgroundCompletion } from "./subagent-background-notify";
import type { RuntimeInputSink, SubagentJob } from "./subagent-types";

describe("durable background notification resume", () => {
  it("enqueues durable notification and schedules the parent session resume", async () => {
    const host = createDurableHost();
    const inlineNotifications: UserInput[] = [];
    const job = createCompletedBackgroundJob(host);
    const jobs = new Map([[job.id, job]]);

    await notifyBackgroundCompletion({
      endEvent: {
        eventCount: 1,
        status: "completed",
        subagent: "researcher",
        task_id: job.id,
        type: "subagent-job-end",
      },
      groups: new Map(),
      job,
      jobs,
      parentSession: createParentSession(inlineNotifications),
    });

    await expect(
      host.store.notifications.getByIdempotencyKey(
        "background-complete:default:bg_1"
      )
    ).resolves.toEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          text: expect.stringContaining("bg_1"),
        }),
        observerEvents: [
          expect.objectContaining({
            task_id: "bg_1",
            type: "subagent-job-end",
          }),
        ],
        sessionKey: "default",
        status: "pending",
      })
    );
    expect(host.resumedSessionKeys).toEqual(["default"]);
    expect(host.resumedSessions).toEqual([
      {
        options: expect.objectContaining({
          idempotencyKey: "background-complete:default:bg_1",
        }),
        sessionKey: "default",
      },
    ]);
    expect(inlineNotifications).toEqual([]);

    await notifyBackgroundCompletion({
      endEvent: {
        eventCount: 1,
        status: "completed",
        subagent: "researcher",
        task_id: job.id,
        type: "subagent-job-end",
      },
      groups: new Map(),
      job,
      jobs,
      parentSession: createParentSession(inlineNotifications),
    });

    expect(host.resumedSessionKeys).toEqual(["default", "default"]);
  });
});

interface DurableTestHost extends ExecutionHost {
  readonly resumedSessionKeys: readonly string[];
  readonly resumedSessions: readonly {
    readonly options?: ResumeSessionOptions;
    readonly sessionKey: string;
  }[];
}

function createDurableHost(): DurableTestHost {
  const base = createInMemoryExecutionHost();
  const resumedSessionKeys: string[] = [];
  const resumedSessions: {
    readonly options?: ResumeSessionOptions;
    readonly sessionKey: string;
  }[] = [];
  return {
    ...base,
    capabilities: {
      backgroundSubagents: "durable",
    },
    scheduler: {
      enqueueRun: () => Promise.resolve(),
      resumeSession: (sessionKey, options) => {
        resumedSessionKeys.push(sessionKey);
        resumedSessions.push({ options, sessionKey });
        return Promise.resolve();
      },
    },
    resumedSessionKeys,
    resumedSessions,
  };
}

function createCompletedBackgroundJob(host: ExecutionHost): SubagentJob {
  return {
    abort: () => undefined,
    childRunId: "background:bg_1",
    cleanup: () => Promise.resolve(),
    executionHost: host,
    id: "bg_1",
    ownerNamespace: agentNamespace("notify-owner"),
    parentSessionKey: "default",
    promise: Promise.resolve(),
    sessionKey: "child:bg_1",
    settled: true,
    status: "completed",
    subagent: "researcher",
  };
}

function createParentSession(notifications: UserInput[]): RuntimeInputSink {
  return {
    emitObserverEvent: () => Promise.resolve(),
    enqueueRuntimeInput: () => undefined,
    notify: (input) => {
      notifications.push(input);
      return Promise.resolve(createEmptyRun());
    },
  };
}

function createEmptyRun(): AgentRun {
  return {
    events: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve({
              done: true,
              value: undefined,
            }),
        };
      },
    }),
  };
}
