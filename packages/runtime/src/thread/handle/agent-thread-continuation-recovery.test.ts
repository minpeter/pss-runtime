import type { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { resumeAgentTurn } from "../../agent/resume/resume";
import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import { deferred } from "../../internal/deferred";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import { createInMemoryHost } from "../../platform/memory";
import { MemoryThreadStore } from "../../platform/memory/storage/memory-thread-store";
import { createMockLanguageModelV4 } from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
} from "../../testing/test-fixtures";
import { encodeThreadSnapshot } from "../state/snapshot";
import { DisposedResourceError } from "../state/thread-errors";
import { AgentThread } from "./agent-thread";
import { createAgentThreadContext } from "./agent-thread-context";
import {
  continueAgentThread,
  resumeClaimedExecutionRunOnThread,
} from "./agent-thread-continuation";
import { ensureAgentThreadStarted } from "./agent-thread-lifecycle";
import { collect } from "./test-support";

const STORAGE_RECOVERY = /storage recovery/i;

afterEach(() => {
  vi.restoreAllMocks();
});

async function unhandledRejectionsDuring(
  action: () => Promise<void>
): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await action();
    // Node reports unhandled rejections only after the microtask queue drains.
    const drained = deferred<void>();
    setImmediate(() => drained.resolve(undefined));
    await drained.promise;
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  return reasons;
}

function countingModel(reply: string): {
  readonly calls: () => number;
  readonly model: MockLanguageModelV4;
} {
  let calls = 0;
  return {
    calls: () => calls,
    model: createCallbackModel(() => {
      calls += 1;
      return Promise.resolve([assistantMessage(reply)]);
    }),
  };
}

describe("thread continuation admission", () => {
  it("rejects continue() on a disposed thread without an unhandled rejection", async () => {
    // Given: a disposed agent thread.
    const agent = await createAgent({
      host: createInMemoryHost(),
      model: countingModel("UNREACHABLE").model,
    });
    const thread = agent.thread("continue-after-dispose");
    await thread.dispose();

    // When: the caller continues and handles the rejection.
    const reasons = await unhandledRejectionsDuring(async () => {
      await expect(thread.continue()).rejects.toBeInstanceOf(
        DisposedResourceError
      );
    });

    // Then: no internal promise is left rejected without an observer.
    expect(reasons).toEqual([]);
  });

  it("rejects continue() on a killed thread without an unhandled rejection", async () => {
    // Given: a killed agent thread.
    const thread = new AgentThread(
      { model: countingModel("UNREACHABLE").model },
      { key: "continue-after-kill", store: new MemoryThreadStore() }
    );
    thread.kill();

    // When: the caller continues and handles the rejection.
    const reasons = await unhandledRejectionsDuring(async () => {
      await expect(thread.continue()).rejects.toThrow("Thread killed");
    });

    // Then: no internal promise is left rejected without an observer.
    expect(reasons).toEqual([]);
  });

  it("rejects continue() with an aborted signal without an unhandled rejection", async () => {
    // Given: an open thread and a caller signal that is already aborted.
    const agent = await createAgent({
      host: createInMemoryHost(),
      model: countingModel("UNREACHABLE").model,
    });
    const thread = agent.thread("continue-aborted");
    const reason = new Error("caller aborted");

    // When: the caller continues and handles the rejection.
    const reasons = await unhandledRejectionsDuring(async () => {
      await expect(
        thread.continue({ signal: AbortSignal.abort(reason) })
      ).rejects.toBe(reason);
    });

    // Then: no internal promise is left rejected without an observer.
    expect(reasons).toEqual([]);
  });
});

describe("crash recovery with earlier completed tools", () => {
  async function seedMultiToolCrash(runId: string, threadKey: string) {
    const host = createInMemoryHost();
    await host.store.threads.commit(
      threadKey,
      {
        state: encodeThreadSnapshot([
          { content: "deploy, then verify", role: "user" },
        ]),
      },
      { expectedVersion: null }
    );
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "running",
      threadKey,
    });
    await host.store.checkpoints.append(
      {
        checkpointId: `${runId}:1:after-tool`,
        phase: "after-tool",
        runId,
        runtimeState: {
          hasOutput: true,
          input: {},
          output: "VERIFIED",
          priorCompletedToolCalls: [
            { toolCallId: "call-deploy", toolName: "deploy" },
          ],
          toolCallId: "call-verify",
          toolName: "verify",
        },
        threadSnapshot: {},
        version: 1,
      },
      { expectedVersion: 0 }
    );
    return host;
  }

  it("parks the run instead of resuming when an earlier completed tool is not in committed history", async () => {
    // Given: a crashed run whose latest checkpoint is the second of two
    // completed tools; the first tool result was never committed.
    const runId = "multi-tool-crash";
    const host = await seedMultiToolCrash(runId, "multi-tool-thread");
    const model = countingModel("UNREACHABLE");
    const agent = await createAgent({ host, model: model.model });
    const thread = agent.thread("multi-tool-thread");

    // When: the thread is continued.
    const continued = thread.continue();

    // Then: recovery fails closed, names the lost tool call, and parks the run.
    await expect(continued).rejects.toBeInstanceOf(
      ToolExecutionNeedsRecoveryError
    );
    await expect(continued).rejects.toThrow(runId);
    await expect(continued).rejects.toThrow("call-deploy");
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "needs-recovery",
    });
    expect((await host.store.turns.get(runId))?.lease).toBeUndefined();

    // And: later recovery attempts keep failing closed without the model.
    await expect(thread.continue()).rejects.toThrow(runId);
    await expect(agent.resume(runId)).resolves.toBeNull();
    expect(model.calls()).toBe(0);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "needs-recovery",
    });
  });

  it("parks the run when agent.resume cannot restore an earlier completed tool", async () => {
    // Given: the same lost first tool result.
    const runId = "multi-tool-resume";
    const host = await seedMultiToolCrash(runId, "multi-tool-resume-thread");
    const model = countingModel("UNREACHABLE");
    const agent = await createAgent({ host, model: model.model });

    // When: the run is resumed by id.
    const resumed = agent.resume(runId);

    // Then: it fails closed instead of being requeued for another attempt.
    await expect(resumed).rejects.toBeInstanceOf(
      ToolExecutionNeedsRecoveryError
    );
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "needs-recovery",
    });
    expect((await host.store.turns.get(runId))?.lease).toBeUndefined();
    await expect(agent.resume(runId)).resolves.toBeNull();
    expect(model.calls()).toBe(0);
  });

  it("recovers when every earlier completed tool is already committed", async () => {
    // Given: the earlier tool result is part of committed history.
    const runId = "multi-tool-committed";
    const threadKey = "multi-tool-committed-thread";
    const host = await seedMultiToolCrash(runId, threadKey);
    const stored = await host.store.threads.load(threadKey);
    await host.store.threads.commit(
      threadKey,
      {
        state: encodeThreadSnapshot([
          { content: "deploy, then verify", role: "user" },
          {
            content: [
              {
                input: {},
                toolCallId: "call-deploy",
                toolName: "deploy",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { type: "text", value: "DEPLOYED" },
                toolCallId: "call-deploy",
                toolName: "deploy",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ]),
      },
      { expectedVersion: stored?.version ?? null }
    );
    const model = countingModel("RECOVERED");
    const agent = await createAgent({ host, model: model.model });

    // When: the thread is continued.
    const turn = await agent.thread(threadKey).continue();

    // Then: the run resumes and completes.
    if (!turn) {
      throw new Error("Expected the crashed run to continue.");
    }
    expect(eventTypes(await collect(turn))).toContain("turn-end");
    expect(model.calls()).toBe(1);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "completed",
    });
  });
});

describe("agent.resume ownership handoff", () => {
  it("does not wedge later send() after a transient start failure of resumed input", async () => {
    // Given: crashed admission left durable input and its queued run, and the
    // first attempt to start that run fails transiently.
    const host = createInMemoryHost();
    const threadKey = "resume-start-failure";
    const runId = createThreadExecutionRunId({
      threadKey,
      turnId: "msg-start-failure",
    });
    await host.store.inputs.admit({
      input: { text: "pending prompt", type: "user-input" },
      kind: "send",
      messageId: "msg-start-failure",
      threadKey,
    });
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey,
    });
    const create = host.store.turns.create.bind(host.store.turns);
    let failStart = true;
    vi.spyOn(host.store.turns, "create").mockImplementation(async (record) => {
      if (failStart && record.runId === runId) {
        failStart = false;
        throw new Error("transient start failure");
      }
      return await create(record);
    });
    const agent = await createAgent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const resumed = await agent.resume(runId);
    if (!resumed) {
      throw new Error("Expected agent.resume to hand off pending input.");
    }
    expect(eventTypes(await collect(resumed))).toContain("turn-error");
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "queued",
    });
    expect((await host.store.turns.get(runId))?.lease).toBeUndefined();

    // When: the thread receives new input.
    const later = await agent.thread(threadKey).send("later prompt");

    // Then: both the pending input and the new input complete.
    expect(eventTypes(await collect(later))).toContain("turn-end");
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("cancels a superseded crashed run instead of replying on newer history", async () => {
    // Given: run R0 crashed, then a later send completed on the same thread.
    const host = createInMemoryHost();
    const threadKey = "superseded-resume";
    await host.store.threads.commit(
      threadKey,
      {
        state: encodeThreadSnapshot([{ content: "first", role: "user" }]),
      },
      { expectedVersion: null }
    );
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: "superseded-r0",
      runId: "superseded-r0",
      status: "running",
      threadKey,
    });
    const model = countingModel("REPLY");
    const agent = await createAgent({ host, model: model.model });
    expect(
      eventTypes(await collect(await agent.thread(threadKey).send("second")))
    ).toContain("turn-end");
    expect(model.calls()).toBe(1);

    // When: a restarted agent resumes the superseded run by id.
    const restarted = await createAgent({
      host: { ...host, store: sharedStoreView(host.store) },
      model: model.model,
    });
    const resumed = await restarted.resume("superseded-r0");

    // Then: it is cancelled without another model reply.
    expect(resumed).toBeNull();
    expect(model.calls()).toBe(1);
    const superseded = await host.store.turns.get("superseded-r0");
    expect(superseded).toMatchObject({ status: "cancelled" });
    expect(superseded?.lease).toBeUndefined();
  });

  it("keeps the in-memory storage-recovery fence when resuming in-process", async () => {
    // Given: a loaded thread whose terminal save failed in this process, so
    // its continuation carries a storage-recovery fence over a running run.
    const host = createInMemoryHost();
    const threadKey = "fenced-resume";
    await host.store.threads.commit(
      threadKey,
      {
        state: encodeThreadSnapshot([{ content: "fenced", role: "user" }]),
      },
      { expectedVersion: null }
    );
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: "fenced-run",
      runId: "fenced-run",
      status: "running",
      threadKey,
    });
    let modelCalls = 0;
    const context = createAgentThreadContext(
      {
        model: createMockLanguageModelV4(() => {
          modelCalls += 1;
          throw new Error("UNREACHABLE");
        }),
      },
      { key: threadKey, store: host.store.threads },
      { executionHost: host }
    );
    await ensureAgentThreadStarted(context);
    context.state.setContinuationCheckpoint(
      context.state.modelSnapshot(),
      () => {
        throw new Error(
          "Task requires storage recovery: terminal state could not be saved."
        );
      }
    );

    // When: the same process resumes the run by id.
    const resumed = resumeAgentTurn({
      host,
      ownerNamespace: "",
      resumeExecutionTurn: (run, checkpoint) =>
        resumeClaimedExecutionRunOnThread(
          context,
          { kind: run.kind, leaseId: run.lease.leaseId, runId: run.runId },
          checkpoint
        ),
      resumeNotification: () => {
        throw new Error("Unexpected notification resume.");
      },
      runId: "fenced-run",
    });

    // Then: the fence rejects resume and stays in place for every route.
    await expect(resumed).rejects.toThrow(STORAGE_RECOVERY);
    expect(modelCalls).toBe(0);
    expect(context.state.continuationCheckpoint()?.recover).toBeDefined();
    await expect(continueAgentThread(context)).rejects.toThrow(
      STORAGE_RECOVERY
    );
    expect(modelCalls).toBe(0);
  });
});

function sharedStoreView<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
