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
    const crashed = modelThatWaits();
    const agent = await createAgent({ host, model: crashed.model });
    collect(await agent.thread(THREAD).send("go")).catch(() => undefined);
    await crashed.started.promise;
    await expireLease(host);
    const restarted = await createAgent({
      host: restartedHost(host),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

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
});

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
