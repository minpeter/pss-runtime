import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { deferred } from "../../internal/deferred";
import type { ModelStepOutput } from "../../llm/model-step-types";
import { createCelldSqliteTestStorage } from "../../platform/durable-object/celld/celld-sqlite-test-storage";
import {
  createCelldHost,
  drainCelldScheduledWork,
  listCelldScheduledBackstops,
} from "../../platform/durable-object/celld/host";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
} from "../../testing/test-fixtures";
import {
  callTools,
  crashDuringTurn,
  expireLease,
  hangingTool,
  latestRun,
  restartedHost,
  THREAD,
} from "../../thread/handle/crash-recovery.test-support";
import { collect } from "../../thread/handle/test-support";
import type { AgentHost } from "../host/types";
import {
  TURN_BACKSTOP_DELAY_MS,
  TURN_BACKSTOP_MARGIN_MS,
} from "./turn-backstop";

describe("turn backstops", () => {
  it("checks a running turn later and drops the check once it settles", async () => {
    // Given: a turn waiting on its model, on a host that schedules backstops.
    const { host, storage } = celldHost();
    const { model, release, started } = modelThatWaits();
    const agent = await createAgent({ host, model });
    const turn = await agent.thread(THREAD).send("go");
    const events = collect(turn);
    await started.promise;
    const startedAt = Date.now();

    // When: the turn runs, and then finishes.
    const whileRunning = await listCelldScheduledBackstops(storage, {
      nowMs: startedAt + TURN_BACKSTOP_DELAY_MS + 1000,
    });
    const beforeDue = await listCelldScheduledBackstops(storage, {
      nowMs: startedAt,
    });
    const alarm = await storage.getAlarm();
    release.resolve([assistantMessage("DONE")]);
    await events;

    // Then: its run had one check due after the lease, gone once settled.
    expect(whileRunning).toEqual([{ runId: turn.runId, threadKey: THREAD }]);
    expect(beforeDue).toEqual([]);
    expect(alarm).toBeLessThanOrEqual(startedAt + TURN_BACKSTOP_DELAY_MS);
    await expect(
      listCelldScheduledBackstops(storage, {
        nowMs: startedAt + TURN_BACKSTOP_DELAY_MS + 1000,
      })
    ).resolves.toEqual([]);
  });

  it("resumes a crashed run once its backstop comes due", async () => {
    // Given: a turn whose process died while its model was answering.
    const { host, storage } = celldHost();
    await crashWhileModelAnswers(host);
    const restarted = await answeringAgent(restartedHost(host));

    // When: the alarm drains the due backstop.
    const drained = await drainCelldScheduledWork({
      agentForRun: () => restarted,
      nowMs: Date.now() + TURN_BACKSTOP_DELAY_MS + 1000,
      storage,
    });

    // Then: the run is resumed and finished, leaving no check behind.
    const { runId } = await latestRun(host);
    expect(drained.ackedBackstops).toEqual([runId]);
    expect(eventTypes([...drained.events])).toContain("turn-end");
    expect(await latestRun(host)).toMatchObject({ status: "completed" });
    await expect(
      listCelldScheduledBackstops(storage, {
        nowMs: Date.now() + 2 * TURN_BACKSTOP_DELAY_MS,
      })
    ).resolves.toEqual([]);
  });

  it("moves a live owner's check past its renewed lease", async () => {
    // Given: a live turn whose heartbeat renewed its lease past the check.
    const { host, storage } = celldHost();
    const { model, started } = modelThatWaits();
    const agent = await createAgent({ host, model });
    collect(await agent.thread(THREAD).send("go")).catch(() => undefined);
    await started.promise;
    const run = await latestRun(host);
    if (!run.lease) {
      throw new Error("Expected a leased run.");
    }
    const dueAtMs = Date.now() + TURN_BACKSTOP_DELAY_MS + 1000;
    const leaseUntilMs = dueAtMs + 60_000;
    await host.store.turns.update({
      ...run,
      lease: { ...run.lease, leaseUntilMs },
    });

    // When: the alarm drains the due backstop.
    const drained = await drainCelldScheduledWork({
      agentForRun: () => agent,
      nowMs: dueAtMs,
      storage,
    });

    // Then: the turn keeps running and is checked again after its lease.
    const recheckAtMs = leaseUntilMs + TURN_BACKSTOP_MARGIN_MS;
    expect(drained.skippedBackstops).toEqual([run.runId]);
    expect(await latestRun(host)).toMatchObject({ status: "running" });
    await expect(
      listCelldScheduledBackstops(storage, { nowMs: recheckAtMs - 1 })
    ).resolves.toEqual([]);
    await expect(
      listCelldScheduledBackstops(storage, { nowMs: recheckAtMs })
    ).resolves.toEqual([{ runId: run.runId, threadKey: THREAD }]);
  });

  it("parks a run that crashed in a manual-recovery tool and drops its check", async () => {
    // Given: a turn whose process died inside a manual-recovery tool.
    const { host, storage } = celldHost();
    const side = hangingTool("manual-recovery");
    await crashDuringTurn(host, { side: side.tool }, side.called(), [
      callTools(["call-1", "side"]),
    ]);
    const restarted = await createAgent({
      host: restartedHost(host),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      tools: { side: side.tool },
    });

    // When: the alarm drains the due backstop.
    const drained = await drainCelldScheduledWork({
      agentForRun: () => restarted,
      nowMs: Date.now() + TURN_BACKSTOP_DELAY_MS + 1000,
      storage,
    });

    // Then: the run waits for a decision; the tool did not run again.
    const { runId } = await latestRun(host);
    expect(drained.ackedBackstops).toEqual([runId]);
    expect(await latestRun(host)).toMatchObject({ status: "needs-recovery" });
    expect(side.calls).toHaveLength(1);
    await expect(
      listCelldScheduledBackstops(storage, {
        nowMs: Date.now() + 2 * TURN_BACKSTOP_DELAY_MS,
      })
    ).resolves.toEqual([]);
  });

  it("resumes a run that a failed resume left queued", async () => {
    // Given: a crashed run whose first resume fails after claiming it, which
    // puts the run back in the queue.
    const { host, storage } = celldHost();
    await crashWhileModelAnswers(host);
    const restarted = await answeringAgent(
      failingCheckpointReadOnce(restartedHost(host))
    );
    const dueAtMs = Date.now() + TURN_BACKSTOP_DELAY_MS + 1000;
    await expect(
      drainCelldScheduledWork({
        agentForRun: () => restarted,
        nowMs: dueAtMs,
        storage,
      })
    ).rejects.toThrow("transient store failure");
    const { runId } = await latestRun(host);
    expect(await latestRun(host)).toMatchObject({ status: "queued" });

    // When: the alarm drains the retried backstop.
    const drained = await drainCelldScheduledWork({
      agentForRun: () => restarted,
      nowMs: dueAtMs + 5000,
      storage,
    });

    // Then: the queued run is resumed and finished, leaving no check.
    expect(drained.ackedBackstops).toEqual([runId]);
    expect(eventTypes([...drained.events])).toContain("turn-end");
    expect(await latestRun(host)).toMatchObject({ status: "completed" });
    await expect(
      listCelldScheduledBackstops(storage, {
        nowMs: Date.now() + 4 * TURN_BACKSTOP_DELAY_MS,
      })
    ).resolves.toEqual([]);
  });

  it("frees a run whose backstop could not be scheduled after it started", async () => {
    // Given: a host whose scheduler schedules backstops only after commit,
    // and fails to.
    const base = createInMemoryHost();
    const host: AgentHost = {
      ...base,
      scheduler: {
        enqueueRun: (runId, options) =>
          base.scheduler.enqueueRun(runId, options),
        resumeThread: (threadKey, options) =>
          base.scheduler.resumeThread(threadKey, options),
        scheduleBackstop: () =>
          Promise.reject(new Error("scheduler unavailable")),
      },
    };
    const agent = await answeringAgent(host);

    // When: a turn starts.
    const events = eventTypes(
      await collect(await agent.thread(THREAD).send("go"))
    );

    // Then: the turn fails, and its run is left queued without a lease rather
    // than running under one nobody renews.
    expect(events).toContain("turn-error");
    const run = await latestRun(host);
    expect(run.status).toBe("queued");
    expect(run.lease).toBeUndefined();
  });
});

/** Runs a turn on `host` whose process dies while its model answers. */
async function crashWhileModelAnswers(host: AgentHost): Promise<void> {
  const crashed = modelThatWaits();
  const agent = await createAgent({ host, model: crashed.model });
  collect(await agent.thread(THREAD).send("go")).catch(() => undefined);
  await crashed.started.promise;
  await expireLease(host);
}

/** An agent on `host` whose model answers "DONE". */
function answeringAgent(host: AgentHost) {
  return createAgent({
    host,
    model: createCallbackModel(() =>
      Promise.resolve([assistantMessage("DONE")])
    ),
  });
}

function celldHost() {
  const storage = createCelldSqliteTestStorage();
  return {
    host: createCelldHost({ state: { storage, waitUntil: () => undefined } }),
    storage,
  };
}

/** A model that answers once released, or never. */
function modelThatWaits() {
  const started = deferred<void>();
  const release = deferred<ModelStepOutput>();
  return {
    model: createCallbackModel(() => {
      started.resolve();
      return release.promise;
    }),
    release,
    started,
  };
}

/** `host` whose first checkpoint read fails, as a transient store error. */
function failingCheckpointReadOnce<Host extends AgentHost>(host: Host): Host {
  let failed = false;
  const checkpoints = host.store.checkpoints;
  return {
    ...host,
    store: new Proxy(host.store, {
      get(target, property) {
        if (property === "checkpoints") {
          return {
            ...checkpoints,
            latest: (runId: string) => {
              if (failed) {
                return checkpoints.latest(runId);
              }
              failed = true;
              return Promise.reject(new Error("transient store failure"));
            },
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
