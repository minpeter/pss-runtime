import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "../../agent/core/agent";
import {
  TURN_LEASE_MS,
  TURN_LEASE_RENEW_MS,
} from "../../execution/host/lease-owner";
import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import type { AgentHost, LeaseOwnerLiveness } from "../../execution/host/types";
import { deferred } from "../../internal/deferred";
import type { ModelStepOutput } from "../../llm/model-step-types";
import { createInMemoryHost } from "../../platform/memory";
import { checkpointedTool } from "../../testing/execution-checkpoint-test-support";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  toolCallPart,
} from "../../testing/test-fixtures";
import { encodeThreadSnapshot } from "../state/snapshot";
import {
  drainContinuation,
  latestRun,
  restartedHost,
  scriptedModel,
  THREAD,
} from "./crash-recovery.test-support";
import { collect } from "./test-support";

afterEach(() => {
  vi.useRealTimers();
});

describe("durable turn leases", () => {
  it("keeps a live turn from being taken over by another process", async () => {
    // Given: a turn that is still waiting on its model.
    const host = createInMemoryHost();
    const { model, started } = modelThatWaits();
    const agent = await createAgent({ host, model });
    const turn = await agent.thread(THREAD).send("go");
    collect(turn).catch(() => undefined);
    await started.promise;

    // When: another process tries to continue or resume its run.
    const other = await createAgent({
      host: restartedHost(host),
      model: scriptedModel([]).model,
    });
    const continued = other.thread(THREAD).continue();

    // Then: the run stays with its live owner.
    await expect(continued).rejects.toMatchObject({
      code: "THREAD_CONTINUATION_BUSY",
    });
    await expect(other.resume(turn.runId ?? "")).resolves.toBeNull();
    expect(await latestRun(host)).toMatchObject({ status: "running" });
  });

  it.each([
    [true, "continues"],
    [false, "waits for the lease"],
  ] as const)(
    "with owner-gone evidence %s, a restarted process %s",
    async (gone, _outcome) => {
      // Given: a run leased by a process that crashed mid-turn.
      const host = await hostWithCrashedOwner();
      const liveness: LeaseOwnerLiveness = {
        isGone: (owner) => gone && owner.id === "crashed-process",
      };
      const model = scriptedModel([]);
      const agent = await createAgent({
        host: { ...restartedHost(host), ownerLiveness: liveness },
        model: model.model,
      });

      // When: the restarted process continues the thread.
      const continued = drainContinuation(agent, model.histories);

      // Then: proof that the owner is gone frees its live lease at once.
      if (gone) {
        await expect(continued).resolves.toMatchObject({
          events: expect.arrayContaining(["turn-end"]),
        });
        expect(model.histories[0]).toContain("go");
      } else {
        await expect(continued).rejects.toMatchObject({
          code: "THREAD_CONTINUATION_BUSY",
        });
      }
    }
  );

  it("stops a turn and writes nothing once another process takes its run over", async () => {
    // Given: a turn waiting on its model, renewing its lease on a timer.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout"],
    });
    const host = createInMemoryHost();
    const { model, started } = modelThatWaits();
    const agent = await createAgent({ host, model });
    const events = collect(await agent.thread(THREAD).send("go"));
    await started.promise;
    const committed = await host.store.threads.load(THREAD);

    // When: another process claims the run after its lease lapsed, and the
    // turn's next renewal finds out.
    await takeOverRun(host);
    await vi.advanceTimersByTimeAsync(TURN_LEASE_RENEW_MS);

    // Then: the turn reports the takeover without writing its outcome.
    expect((await events).at(-1)).toMatchObject({
      error: { code: "THREAD_OWNERSHIP_LOST" },
      type: "turn-error",
    });
    await expect(host.store.threads.load(THREAD)).resolves.toEqual(committed);
    expect(await latestRun(host)).toMatchObject({
      lease: { leaseId: "new-owner" },
      status: "leased",
    });
  });

  it.each([
    ["its model request fails", "fail"],
    ["its tool's checkpoint is refused", "tool"],
  ] as const)(
    "reports a takeover found when %s before its renewal",
    async (_case, kind) => {
      // Given: a turn waiting on its model, whose run another process claims
      // after the lease lapsed, before the turn's next renewal.
      const host = createInMemoryHost();
      const started = deferred<void>();
      const answer = deferred<void>();
      const effects = { count: 0 };
      let requests = 0;
      const agent = await createAgent({
        host,
        model: createCallbackModel(async () => {
          requests += 1;
          if (requests > 1) {
            return [assistantMessage("DONE")];
          }
          started.resolve();
          await answer.promise;
          if (kind === "fail") {
            throw new Error("upstream failed");
          }
          return [assistantMessage([toolCallPart("call-act", "act")])];
        }),
        tools: {
          act: checkpointedTool("idempotent", () => {
            effects.count += 1;
            return "ACTED";
          }),
        },
      });
      const thread = agent.thread(THREAD);
      const events = collect(await thread.send("go"));
      await started.promise;
      const committed = await host.store.threads.load(THREAD);
      await takeOverRun(host);

      // When: the model answers.
      answer.resolve();

      // Then: the turn reports the takeover, writes nothing and runs no tool,
      // and the handle still takes new work.
      expect((await events).at(-1)).toMatchObject({
        error: { code: "THREAD_OWNERSHIP_LOST" },
        type: "turn-error",
      });
      await expect(host.store.threads.load(THREAD)).resolves.toEqual(committed);
      expect(effects.count).toBe(0);
      expect(eventTypes(await collect(await thread.send("again")))).toContain(
        "turn-end"
      );
    }
  );
});

/** Another process claims the thread's run after its lease lapsed. */
async function takeOverRun(host: AgentHost): Promise<void> {
  const { runId } = await latestRun(host);
  await host.store.turns.claim(runId, {
    attempt: 2,
    leaseId: "new-owner",
    leaseMs: TURN_LEASE_MS,
    nowMs: Date.now() + TURN_LEASE_MS + 1,
  });
}

/** A model that waits until its request is cancelled. */
function modelThatWaits() {
  const started = deferred<void>();
  return {
    model: createCallbackModel(
      ({ signal }) =>
        new Promise<ModelStepOutput>((_resolve, reject) => {
          started.resolve();
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    ),
    started,
  };
}

/** A thread whose run is still leased by a process that crashed. */
async function hostWithCrashedOwner(): Promise<AgentHost> {
  const host = createInMemoryHost();
  await host.store.threads.commit(
    THREAD,
    { state: encodeThreadSnapshot([{ content: "go", role: "user" }]) },
    { expectedVersion: null }
  );
  const runId = createThreadExecutionRunId({
    threadKey: THREAD,
    turnId: "crashed-turn",
  });
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    lease: {
      attempt: 1,
      leaseId: "crashed-lease",
      leaseUntilMs: Date.now() + TURN_LEASE_MS,
      owner: { id: "crashed-process" },
    },
    rootRunId: runId,
    runId,
    status: "running",
    threadKey: THREAD,
  });
  return host;
}
