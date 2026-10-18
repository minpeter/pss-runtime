import { describe, expect, it } from "vitest";
import { Agent } from "../../../agent/core/agent";
import type {
  HostStore,
  TurnRecord,
  TurnStatus,
} from "../../../execution/host/types";
import {
  assistantMessage,
  createCallbackModel,
} from "../../../testing/test-fixtures";
import type { AgentEvent } from "../../../thread/protocol/events";
import type { AgentTurn } from "../../../thread/protocol/turn";
import { createInMemoryHost } from "../../memory/execution/execution-host";
import { createCelldTestStorage } from "./celld-test-storage";
import {
  type CelldScheduledWorkAgent,
  drainCelldScheduledWork,
} from "./drainer";
import {
  createCelldScheduler,
  listCelldScheduledRuns,
  listCelldScheduledThreadPrompts,
} from "./scheduler";

describe("drainCelldScheduledWork", () => {
  it("consumes run events and acknowledges completed work", async () => {
    const storage = createCelldTestStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("run-1");
    const events: AgentEvent[] = [{ type: "turn-start" }, { type: "turn-end" }];
    const agent = createAgent({ run: turn(events) });

    const result = await drainCelldScheduledWork({
      agentForRun: () => agent,
      nowMs: 0,
      storage,
    });

    expect(result.events).toEqual(events);
    expect(result.ackedRuns).toEqual(["run-1"]);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 0 })
    ).resolves.toEqual([]);
  });

  it("leaves a nonterminal null resume pending", async () => {
    const storage = createCelldTestStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("run-1");
    const agent = createAgent({ record: runRecord("queued"), run: null });

    const result = await drainCelldScheduledWork({
      agentForRun: () => agent,
      nowMs: 0,
      storage,
    });

    expect(result.skippedRuns).toEqual(["run-1"]);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 999 })
    ).resolves.toEqual([]);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 1000 })
    ).resolves.toEqual(["run-1"]);
    await expect(storage.getAlarm()).resolves.toBe(1000);
  });

  it("claims a scheduled run before only one concurrent drain resumes it", async () => {
    const storage = createCelldTestStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("run-1");
    let resumes = 0;
    const agent = createAgent({
      run: turn([{ type: "turn-end" }]),
      resume: () => {
        resumes += 1;
        return Promise.resolve(turn([{ type: "turn-end" }]));
      },
    });

    await Promise.all([
      drainCelldScheduledWork({
        agentForRun: () => agent,
        nowMs: 0,
        storage,
      }),
      drainCelldScheduledWork({
        agentForRun: () => agent,
        nowMs: 0,
        storage,
      }),
    ]);

    expect(resumes).toBe(1);
  });

  it("acknowledges terminal and missing null resumes", async () => {
    for (const record of [runRecord("completed"), null]) {
      const storage = createCelldTestStorage();
      const scheduler = createCelldScheduler({ clock: () => 0, storage });
      await scheduler.enqueueRun("run-1");

      const result = await drainCelldScheduledWork({
        agentForRun: () => createAgent({ record, run: null }),
        nowMs: 0,
        storage,
      });

      expect(result.ackedRuns).toEqual(["run-1"]);
      await expect(
        listCelldScheduledRuns(storage, { nowMs: 0 })
      ).resolves.toEqual([]);
    }
  });

  it("acknowledges a run parked as needs-recovery instead of polling it", async () => {
    // Given
    const storage = createCelldTestStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("run-1");
    await scheduler.resumeThread("thread-1", { runId: "run-1" });
    const agent = createAgent({
      record: runRecord("needs-recovery"),
      run: null,
    });

    // When
    const result = await drainCelldScheduledWork({
      agentForRun: () => agent,
      nowMs: 0,
      storage,
    });

    // Then
    expect(result.ackedRuns).toEqual(["run-1"]);
    expect(result.ackedThreadPrompts).toEqual([
      { runId: "run-1", threadKey: "thread-1" },
    ]);
    expect(result.skippedRuns).toEqual([]);
    expect(result.skippedThreadPrompts).toEqual([]);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: Number.MAX_SAFE_INTEGER })
    ).resolves.toEqual([]);
    await expect(
      listCelldScheduledThreadPrompts(storage, {
        nowMs: Number.MAX_SAFE_INTEGER,
      })
    ).resolves.toEqual([]);
    await expect(storage.getAlarm()).resolves.toBeNull();
  });

  it.each(["running", "needs-recovery"] as const)(
    "acknowledges a %s run whose resume rejects for manual tool recovery",
    async (status) => {
      // Given
      const storage = createCelldTestStorage();
      const scheduler = createCelldScheduler({ clock: () => 0, storage });
      const host = createInMemoryHost();
      await seedManualRecoveryRun(host.store, "run-1", status);
      await scheduler.enqueueRun("run-1");
      await scheduler.resumeThread("default", { runId: "run-1" });
      let modelCalls = 0;
      const agent = new Agent({
        host,
        model: createCallbackModel(() => {
          modelCalls += 1;
          return Promise.resolve([assistantMessage("UNREACHABLE")]);
        }),
      });

      // When
      const result = await drainCelldScheduledWork({
        agentForRun: () => ({
          host,
          resume: (runId) => agent.resume(runId),
        }),
        nowMs: 0,
        storage,
      });

      // Then
      expect(result.ackedRuns).toEqual(["run-1"]);
      expect(result.ackedThreadPrompts).toEqual([
        { runId: "run-1", threadKey: "default" },
      ]);
      expect(result.events).toEqual([]);
      expect(modelCalls).toBe(0);
      await expect(host.store.turns.get("run-1")).resolves.toMatchObject({
        status: "needs-recovery",
      });
      await expect(
        listCelldScheduledRuns(storage, { nowMs: Number.MAX_SAFE_INTEGER })
      ).resolves.toEqual([]);
      await expect(storage.getAlarm()).resolves.toBeNull();
    }
  );

  it("retries a run whose resume rejects while the run is still recoverable", async () => {
    // Given
    const storage = createCelldTestStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("run-1");
    const failure = new Error("transient resume failure");
    const agent = createAgent({
      record: runRecord("queued"),
      resume: () => Promise.reject(failure),
      run: null,
    });

    // When
    const drain = drainCelldScheduledWork({
      agentForRun: () => agent,
      nowMs: 0,
      storage,
    });

    // Then
    await expect(drain).rejects.toBe(failure);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 1000 })
    ).resolves.toEqual(["run-1"]);
  });
});

function createAgent({
  record = null,
  run,
  resume,
}: {
  readonly record?: TurnRecord | null;
  readonly run: AgentTurn | null;
  readonly resume?: () => Promise<AgentTurn | null>;
}): CelldScheduledWorkAgent {
  return {
    host: {
      store: {
        turns: {
          get: () => Promise.resolve(record),
        },
      },
    },
    resume: resume ?? (() => Promise.resolve(run)),
  };
}

function turn(values: readonly AgentEvent[]): AgentTurn {
  async function* events() {
    yield* values;
  }
  return {
    events,
    runId: "run-1",
    [Symbol.asyncIterator]() {
      return events()[Symbol.asyncIterator]();
    },
  };
}

function runRecord(status: TurnStatus): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: "run-1",
    runId: "run-1",
    status,
    threadKey: "thread-1",
  };
}

async function seedManualRecoveryRun(
  store: HostStore,
  runId: string,
  status: TurnStatus
): Promise<void> {
  await store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    status,
    threadKey: "default",
  });
  await store.checkpoints.append(
    {
      checkpointId: `${runId}:1:before-tool`,
      pendingToolCall: {
        attempt: 1,
        idempotencyKey: `${runId}:deploy`,
        policy: "manual-recovery",
        toolCallId: "call-deploy",
        toolName: "deploy",
      },
      phase: "before-tool",
      runId,
      runtimeState: { toolCallId: "call-deploy", toolName: "deploy" },
      threadSnapshot: {},
      version: 1,
    },
    { expectedVersion: 0 }
  );
}
