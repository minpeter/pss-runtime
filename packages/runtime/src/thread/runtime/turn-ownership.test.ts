import { describe, expect, it } from "vitest";
import type { TurnLease } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import {
  startTurnLeaseHeartbeat,
  TurnOwnershipLostError,
} from "./turn-ownership";

const runId = "heartbeat-run";
const lease: TurnLease = {
  attempt: 1,
  leaseId: "owner-a",
  leaseUntilMs: 1000,
  owner: { id: "process-a" },
};

describe("turn lease heartbeat", () => {
  it("renews the lease while the turn runs", async () => {
    // Given: a running run whose lease is about to lapse.
    const host = await hostWithRunningRun();

    // When: the heartbeat runs a few renewals.
    const heartbeat = startTurnLeaseHeartbeat({
      lease,
      leaseMs: 60_000,
      renewMs: 5,
      runId,
      store: host.store,
    });
    await waitUntil(
      async () =>
        ((await host.store.turns.get(runId))?.lease?.leaseUntilMs ?? 0) >
        Date.now()
    );
    heartbeat.release();

    // Then: the same lease now runs well past its old deadline.
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      lease: { leaseId: "owner-a", owner: { id: "process-a" } },
      status: "running",
    });
    expect(heartbeat.lost.aborted).toBe(false);
  });

  it("reports a takeover once another owner replaced the lease", async () => {
    // Given: another owner claimed the run after its lease lapsed.
    const host = await hostWithRunningRun();
    await host.store.turns.claim(runId, {
      attempt: 2,
      leaseId: "owner-b",
      leaseMs: 60_000,
      nowMs: Date.now(),
    });

    // When: the old owner's heartbeat tries to renew.
    const heartbeat = startTurnLeaseHeartbeat({
      lease,
      renewMs: 5,
      runId,
      store: host.store,
    });
    await waitUntil(() => Promise.resolve(heartbeat.lost.aborted));
    heartbeat.release();

    // Then: the heartbeat reports the loss and leaves the new lease alone.
    expect(heartbeat.lost.reason).toBeInstanceOf(TurnOwnershipLostError);
    expect(heartbeat.lost.reason).toMatchObject({ runId });
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      lease: { leaseId: "owner-b" },
    });
  });

  it("renews through a transaction when the store has no atomic transition", async () => {
    // Given: a store whose turn port lacks `transition`.
    const host = await hostWithRunningRun();
    const { transition: _transition, ...turns } = host.store.turns;
    let transactions = 0;
    const store = {
      ...host.store,
      transaction: <Result>(
        fn: Parameters<typeof host.store.transaction<Result>>[0]
      ) => {
        transactions += 1;
        return host.store.transaction(fn);
      },
      turns,
    };

    // When: the heartbeat renews.
    const heartbeat = startTurnLeaseHeartbeat({
      lease,
      leaseMs: 60_000,
      renewMs: 5,
      runId,
      store,
    });
    await waitUntil(
      async () =>
        ((await host.store.turns.get(runId))?.lease?.leaseUntilMs ?? 0) >
        Date.now()
    );
    heartbeat.release();

    // Then: the lease was extended inside a store transaction.
    expect(transactions).toBeGreaterThan(0);
    expect(heartbeat.lost.aborted).toBe(false);
  });
});

async function hostWithRunningRun() {
  const host = createInMemoryHost();
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    lease,
    rootRunId: runId,
    runId,
    status: "running",
    threadKey: "thread",
  });
  return host;
}

async function waitUntil(done: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await done()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition never held.");
}
