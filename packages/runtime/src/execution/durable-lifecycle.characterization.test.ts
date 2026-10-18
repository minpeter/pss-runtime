import { describe, expect, it, vi } from "vitest";
import { Agent, createAgent } from "../agent/core/agent";
import { ToolExecutionNeedsRecoveryError } from "../llm/tool-execution-checkpoint";
import { createInMemoryHost } from "../platform/memory";
import { MemoryThreadStore } from "../platform/memory/storage/memory-thread-store";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  userText,
} from "../testing/test-fixtures";
import { AgentThread } from "../thread/handle/agent-thread";
import { claimOrphanDurableThreadInput } from "../thread/handle/durable-queue-claims";
import { collect } from "../thread/handle/test-support";
import { encodeThreadSnapshot } from "../thread/state/snapshot";
import { DisposedResourceError } from "../thread/state/thread-errors";
import { dispatchAgentNotification } from "./dispatch/notification-dispatch";

import { createThreadExecutionRunId } from "./host/thread-execution-run-id";

describe("durable lifecycle characterization", () => {
  it("dispatches one durable notification for an idempotency key", async () => {
    const host = createInMemoryHost();
    const input = {
      host,
      idempotencyKey: "characterization-notification",
      input: userText("background work completed"),
      namespace: "characterization-agent",
      threadKey: "characterization-thread",
    } as const;

    const first = await dispatchAgentNotification(input);
    const duplicate = await dispatchAgentNotification(input);

    expect(first.deduplicated).toBe(false);
    expect(duplicate).toEqual({ ...first, deduplicated: true });
    await expect(host.store.turns.get(first.runId)).resolves.toEqual(
      expect.objectContaining({
        kind: "notification",
        runId: first.runId,
        status: "queued",
        threadKey: input.threadKey,
      })
    );
  });

  it("resumes a dispatched notification through the same event stream once", async () => {
    const host = createInMemoryHost();
    const agent = new Agent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("notification handled")])
      ),
      namespace: "characterization-agent",
    });
    const dispatched = await dispatchAgentNotification({
      host,
      idempotencyKey: "characterization-resume",
      input: userText("resume this notification"),
      namespace: "characterization-agent",
      threadKey: "characterization-thread",
    });

    const turn = await agent.resume(dispatched.runId);
    expect(turn).not.toBeNull();
    if (!turn) {
      throw new Error("Expected the dispatched notification to resume.");
    }

    expect(eventTypes(await collect(turn))).toEqual([
      "turn-start",
      "runtime-input",
      "step-start",
      "model-usage",
      "assistant-output",
      "step-end",
      "turn-end",
    ]);
    await expect(agent.resume(dispatched.runId)).resolves.toBeNull();
    await expect(host.store.turns.get(dispatched.runId)).resolves.toEqual(
      expect.objectContaining({ status: "completed" })
    );
  });

  it("dispose closes active and queued turns and rejects later input", async () => {
    const modelStarted = createDeferred();
    const modelGate = createDeferred();
    const agent = await createAgent({
      model: createCallbackModel(async () => {
        modelStarted.resolve();
        await modelGate.promise;
        return [assistantMessage("done")];
      }),
    });
    const thread = agent.thread("characterization-dispose");
    const activeEvents = collect(await thread.send("active"));
    const queuedEvents = collect(await thread.send("queued"));
    await modelStarted.promise;

    const disposal = thread.dispose();
    modelGate.resolve();
    await disposal;

    expect(eventTypes(await activeEvents)).toContain("turn-error");
    expect(eventTypes(await queuedEvents)).toEqual([
      "user-input",
      "turn-error",
    ]);
    await expect(thread.send("late")).rejects.toThrow("Thread killed");
  });

  it("kill immediately closes active and queued turns", async () => {
    const modelStarted = createDeferred();
    const modelGate = createDeferred();
    const thread = new AgentThread(
      {
        model: createCallbackModel(async () => {
          modelStarted.resolve();
          await modelGate.promise;
          return [assistantMessage("done")];
        }),
      },
      {
        key: "characterization-kill",
        store: new MemoryThreadStore(),
      }
    );
    const activeEvents = collect(await thread.send("active"));
    const queuedEvents = collect(await thread.send("queued"));
    await modelStarted.promise;

    thread.kill();
    modelGate.resolve();

    expect(eventTypes(await activeEvents)).toContain("turn-error");
    expect(eventTypes(await queuedEvents)).toEqual([
      "user-input",
      "turn-error",
    ]);
    await expect(thread.steer("late")).rejects.toThrow("Thread killed");
  });

  it("resumes an unfinished user-turn across Agent instances via agent.resume and thread.continue", async () => {
    const host = createInMemoryHost();
    await host.store.threads.commit(
      "scope:org:thread:crash-thread",
      {
        state: encodeThreadSnapshot([
          { content: "recover after crash", role: "user" },
        ]),
      },
      { expectedVersion: null }
    );
    await host.store.turns.create({
      checkpointVersion: 0,
      dedupeKey: "crashed-user-turn-1",
      kind: "user-turn",
      rootRunId: "crashed-user-turn-1",
      runId: "crashed-user-turn-1",
      status: "running",
      threadKey: "scope:org:thread:crash-thread",
    });
    await host.store.checkpoints.append(
      {
        checkpointId: "crashed-user-turn-1:1:after-tool",
        pendingToolCall: {
          attempt: 1,
          idempotencyKey: "crashed-user-turn-1:tool-1",
          policy: "manual-recovery",
          toolCallId: "call-1",
          toolName: "lookup",
        },
        phase: "after-tool",
        runId: "crashed-user-turn-1",
        runtimeState: {
          input: { q: "status" },
          output: "TOOL_OUTPUT_RETAINED",
          priorCompletedToolCalls: [],
          priorResultCount: 0,
          toolCallId: "call-1",
          toolName: "lookup",
        },
        threadSnapshot: {
          kind: "thread-reference",
          schemaVersion: 1,
          threadKey: "scope:org:thread:crash-thread",
          threadVersion: "1",
        },
        version: 1,
      },
      { expectedVersion: 0 }
    );

    const seenHistories: unknown[] = [];
    const recoveredAgent = await createAgent({
      host,
      model: createCallbackModel(({ history }) => {
        seenHistories.push(structuredClone(history));
        return Promise.resolve([assistantMessage("RECOVERED_FINAL")]);
      }),
    });
    const thread = recoveredAgent.thread({ id: "crash-thread", scope: "org" });
    expect(thread.identity).toEqual({ id: "crash-thread", scope: "org" });

    const continued = await thread.continue();
    expect(continued?.runId).toBe("crashed-user-turn-1");
    if (!continued) {
      throw new Error("Expected crashed run to continue across restart.");
    }
    const events: string[] = [];
    for await (const event of continued) {
      events.push(event.type);
    }
    expect(events).toContain("turn-end");
    expect(JSON.stringify(seenHistories[0])).toContain("TOOL_OUTPUT_RETAINED");
    await expect(
      host.store.turns.get("crashed-user-turn-1")
    ).resolves.toMatchObject({ status: "completed" });

    const replayed: string[] = [];
    for await (const record of thread.replay()) {
      replayed.push(record.event.type);
    }
    expect(replayed).toContain("turn-end");
    await thread[Symbol.asyncDispose]();
    await expect(thread.send("after-dispose")).rejects.toBeInstanceOf(
      DisposedResourceError
    );

    // A second Agent over a distinct store object sharing the same data, as
    // after a restart: process-local ownership registries key by store.
    const restartedAgent = await createAgent({
      host: { ...host, store: sharedStoreView(host.store) },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("RESTARTED_FINAL")])
      ),
    });

    await host.store.threads.commit(
      "resume-thread",
      {
        state: encodeThreadSnapshot([
          { content: "resume via agent.resume", role: "user" },
        ]),
      },
      { expectedVersion: null }
    );
    await host.store.turns.create({
      checkpointVersion: 0,
      dedupeKey: "crashed-user-turn-2",
      kind: "user-turn",
      rootRunId: "crashed-user-turn-2",
      runId: "crashed-user-turn-2",
      status: "running",
      threadKey: "resume-thread",
    });
    await host.store.checkpoints.append(
      {
        checkpointId: "crashed-user-turn-2:1:after-tool",
        phase: "after-tool",
        runId: "crashed-user-turn-2",
        runtimeState: {
          hasOutput: true,
          input: { step: 2 },
          output: null,
          priorCompletedToolCalls: [],
          priorResultCount: 0,
          toolCallId: "call-2",
          toolName: "void_tool",
        },
        threadSnapshot: {},
        version: 1,
      },
      { expectedVersion: 0 }
    );
    const resumedTurn = await restartedAgent.resume("crashed-user-turn-2");
    expect(resumedTurn?.runId).toBe("crashed-user-turn-2");
    if (!resumedTurn) {
      throw new Error("Expected agent.resume to recover user-turn.");
    }
    expect(eventTypes(await collect(resumedTurn))).toContain("turn-end");
    await expect(
      host.store.turns.get("crashed-user-turn-2")
    ).resolves.toMatchObject({ status: "completed" });
    const pendingRunId = createThreadExecutionRunId({
      threadKey: "fresh-thread",
      turnId: "msg-pending",
    });
    await host.store.inputs.admit({
      input: { text: "pending durable prompt", type: "user-input" },
      kind: "send",
      messageId: "msg-pending",
      threadKey: "fresh-thread",
    });
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: pendingRunId,
      runId: pendingRunId,
      status: "queued",
      threadKey: "fresh-thread",
    });
    const pendingTurn = await restartedAgent.resume(pendingRunId);
    expect(pendingTurn?.runId).toBe(pendingRunId);
    if (!pendingTurn) {
      throw new Error(
        "Expected agent.resume to execute pending durable input."
      );
    }
    expect(eventTypes(await collect(pendingTurn))).toContain("turn-end");
    await expect(host.store.turns.get(pendingRunId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("keeps resumed durable input owned while its inspection claim is released", async () => {
    // Given: crashed admission left input and its queued run, and a local
    // orphan drain tries to claim the input whenever a claim is released.
    const host = createInMemoryHost();
    const threadKey = "resume-handoff-thread";
    const runId = createThreadExecutionRunId({ threadKey, turnId: "msg-race" });
    await host.store.inputs.admit({
      input: { text: "handoff prompt", type: "user-input" },
      kind: "send",
      messageId: "msg-race",
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
    const releaseClaim = host.store.inputs.releaseClaim.bind(host.store.inputs);
    let competingClaim: unknown = "not attempted";
    let competed = false;
    vi.spyOn(host.store.inputs, "releaseClaim").mockImplementation(
      async (claim) => {
        const released = await releaseClaim(claim);
        if (!competed) {
          competed = true;
          competingClaim = await claimOrphanDurableThreadInput({
            executionHost: host,
            threadKey,
          });
        }
        return released;
      }
    );
    const agent = await createAgent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("HANDOFF_FINAL")])
      ),
    });

    // When: the queued run is resumed.
    const turn = await agent.resume(runId);

    // Then: the local drain yields to the resumed turn, which completes.
    expect(competingClaim).toBeUndefined();
    if (!turn) {
      throw new Error(
        "Expected agent.resume to execute pending durable input."
      );
    }
    expect(eventTypes(await collect(turn))).toContain("turn-end");
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("fails closed when resuming a run interrupted mid manual-recovery tool", async () => {
    const host = createInMemoryHost();
    await host.store.turns.create({
      checkpointVersion: 0,
      dedupeKey: "crashed-before-tool",
      kind: "user-turn",
      rootRunId: "crashed-before-tool",
      runId: "crashed-before-tool",
      status: "running",
      threadKey: "default",
    });
    await host.store.checkpoints.append(
      {
        checkpointId: "crashed-before-tool:1:before-tool",
        pendingToolCall: {
          attempt: 1,
          idempotencyKey: "crashed-before-tool:deploy",
          policy: "manual-recovery",
          toolCallId: "call-deploy",
          toolName: "deploy",
        },
        phase: "before-tool",
        runId: "crashed-before-tool",
        runtimeState: {
          toolCallId: "call-deploy",
          toolName: "deploy",
        },
        threadSnapshot: {},
        version: 1,
      },
      { expectedVersion: 0 }
    );

    const agent = new Agent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("UNREACHABLE")])
      ),
    });

    await expect(agent.resume("crashed-before-tool")).rejects.toBeInstanceOf(
      ToolExecutionNeedsRecoveryError
    );
    await expect(agent.resume("crashed-before-tool")).rejects.toBeInstanceOf(
      ToolExecutionNeedsRecoveryError
    );
    await expect(
      host.store.turns.get("crashed-before-tool")
    ).resolves.toMatchObject({ status: "needs-recovery" });
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
