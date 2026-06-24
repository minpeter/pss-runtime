import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkpointedTool,
  createCheckpointSpyHost,
  createQueuedUserTurnRun,
  type GenerateTextToolOptions,
  toolOptions,
} from "../../testing/execution-checkpoint-test-support";
import {
  collectRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
} from "../../testing/llm-test-utils";
import {
  assistantMessage,
  toolCallPart,
  toolResultFor,
} from "../../testing/test-fixtures";
import { dispatchAgentNotification } from "../dispatch/notification-dispatch";
import type { ThreadHost } from "../host/capabilities";
import type { ExecutionStore, ExecutionStoreTransaction } from "../host/types";
import { createInMemoryExecutionHost } from "../memory";
import { inspectDurableTurn } from "./durable-turn";

const generateTextMock = getGenerateTextMock();

describe("inspectDurableTurn", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inspects an accepted Agent.send turn by run id after tool checkpointing", async () => {
    const Agent = await loadAgent();
    const { host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart(
          "call_sdk-tool-call-1",
          "checkpointed_tool"
        );
        await executableTool(
          options.tools ?? {},
          "checkpointed_tool"
        ).execute?.({}, toolOptions("call_sdk-tool-call-1", signal));

        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      })
      .mockImplementationOnce(async () => ({
        responseMessages: [assistantMessage("DONE")],
      }));

    const agent = new Agent({
      host,
      model: fakeModel,
      tools: {
        checkpointed_tool: checkpointedTool("idempotent", () => ({ ok: true })),
      },
    });

    const turn = await agent.send("use the tool");

    expect(turn.runId).toEqual(expect.any(String));

    await collectRun(turn);

    const result = await inspectDurableTurn(host, turn.runId ?? "");

    expect(result).toMatchObject({
      checkpointVersion: expect.any(Number),
      latestCheckpoint: { phase: "after-tool", version: expect.any(Number) },
      runId: turn.runId,
      state: "checkpointed",
      status: "completed",
      threadKey: "default",
      turn: {
        kind: "user-turn",
        status: "completed",
        threadKey: "default",
      },
    });
    if (result.state !== "checkpointed") {
      throw new Error(`Expected checkpointed result, received ${result.state}`);
    }
    expect(result.checkpointVersion).toBe(result.latestCheckpoint.version);
  });

  it("returns unknown-run for an absent run", async () => {
    const host = createInMemoryExecutionHost();

    await expect(inspectDurableTurn(host, "missing-run")).resolves.toEqual({
      runId: "missing-run",
      state: "unknown-run",
    });
  });

  it("returns no-checkpoint with the stored turn when the run has no checkpoint", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.turns.create(
      createQueuedUserTurnRun("run-without-checkpoint")
    );

    await expect(
      inspectDurableTurn(host.store, "run-without-checkpoint")
    ).resolves.toMatchObject({
      checkpointVersion: 0,
      latestCheckpoint: null,
      runId: "run-without-checkpoint",
      state: "no-checkpoint",
      status: "queued",
      turn: {
        kind: "user-turn",
        runId: "run-without-checkpoint",
        status: "queued",
      },
    });
  });

  it("reads the turn and checkpoint inside one execution store transaction", async () => {
    const host = createInMemoryExecutionHost();
    const turn = createQueuedUserTurnRun("transactional-run");
    await host.store.turns.create(turn);
    await host.store.checkpoints.append(
      {
        checkpointId: "checkpoint-1",
        phase: "after-model",
        runId: turn.runId,
        runtimeState: {},
        threadSnapshot: {},
        version: 1,
      },
      { expectedVersion: 0 }
    );

    const transactionalStore: ExecutionStore = {
      ...host.store,
      checkpoints: {
        ...host.store.checkpoints,
        latest: () =>
          Promise.reject(new Error("checkpoint read outside transaction")),
      },
      transaction: async (callback) => {
        const tx: ExecutionStoreTransaction = {
          checkpoints: host.store.checkpoints,
          events: host.store.events,
          notifications: host.store.notifications,
          threads: host.store.threads,
          turns: host.store.turns,
        };
        return await callback(tx);
      },
      turns: {
        ...host.store.turns,
        get: () => Promise.reject(new Error("turn read outside transaction")),
      },
    };

    await expect(
      inspectDurableTurn(transactionalStore, turn.runId)
    ).resolves.toMatchObject({
      checkpointVersion: 1,
      latestCheckpoint: { version: 1 },
      state: "checkpointed",
    });
  });

  it("inspects the existing notification run when dispatch dedupes", async () => {
    const host = createInMemoryExecutionHost();
    const first = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });
    const duplicate = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired again", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    expect(duplicate).toEqual({ ...first, deduplicated: true });

    await expect(
      inspectDurableTurn(host, duplicate.runId)
    ).resolves.toMatchObject({
      checkpointVersion: 0,
      latestCheckpoint: null,
      runId: first.runId,
      state: "no-checkpoint",
      status: "queued",
      threadKey: "room:1:user:2",
      turn: {
        kind: "notification",
        runId: first.runId,
        status: "queued",
        threadKey: "room:1:user:2",
      },
    });
  });

  it("returns unsupported for a thread-only host source", async () => {
    const threadHost = {
      kind: "thread",
      threadStore: createInMemoryExecutionHost().store.threads,
    } satisfies ThreadHost;

    await expect(inspectDurableTurn(threadHost, "run-1")).resolves.toEqual({
      runId: "run-1",
      state: "unsupported",
    });
  });
});
