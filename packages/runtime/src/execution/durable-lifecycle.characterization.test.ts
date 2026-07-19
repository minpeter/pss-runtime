import { describe, expect, it } from "vitest";
import { Agent, createAgent } from "../agent/core/agent";
import { createInMemoryHost } from "../platform/memory";
import { MemoryThreadStore } from "../platform/memory/storage/memory-thread-store";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  userText,
} from "../testing/test-fixtures";
import { collect } from "../thread/handle/test-support";
import { AgentThread } from "../thread/handle/agent-thread";
import { dispatchAgentNotification } from "./dispatch/notification-dispatch";

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
});
