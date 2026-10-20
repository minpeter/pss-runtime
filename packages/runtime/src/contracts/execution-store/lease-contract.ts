import { describe, expect, it } from "vitest";
import {
  type HostStore,
  type TurnStatus,
  transitionTurn,
} from "../../execution";
import { createQueuedRun } from "./fixtures";
import { describeTakeoverOnlyLeaseContract } from "./takeover-lease-contract";

export function describeExecutionLeaseContract(
  name: string,
  createStore: () => HostStore
): void {
  describeTakeoverOnlyLeaseContract(name, createStore);
  describe(`${name} lease fencing`, () => {
    it("provides a native atomic transition", () => {
      const store = createStore();

      expect(store.turns.transition).toEqual(expect.any(Function));
    });

    it.each([
      ["queued", true],
      ["leased", true],
      ["running", true],
      ["suspended", true],
      ["needs-recovery", false],
      ["completed", false],
      ["cancelled", false],
      ["error", false],
    ] satisfies readonly (readonly [TurnStatus, boolean])[])(
      "uses the shared claim decision for %s",
      async (status, claimable) => {
        const store = createStore();
        const runId = `run-${status}`;
        const created = await store.turns.create(createQueuedRun(runId));
        await store.turns.update({ ...created.record, status });

        const result = await store.turns.claim(
          runId,
          claimOptions("owner", 10)
        );
        expect(result.ok).toBe(claimable);
        if (!claimable) {
          expect(result).toEqual({
            ok: false,
            reason: "not-claimable",
          });
        }
      }
    );

    it.each([
      "queued",
      "leased",
      "running",
      "suspended",
    ] satisfies readonly TurnStatus[])(
      "rejects claims for live leases in %s status",
      async (status) => {
        const store = createStore();
        const runId = `run-live-${status}`;
        await store.turns.create(createQueuedRun(runId));
        const claimed = await claim(store, runId, "owner-a", 10);
        await store.turns.update({ ...claimed, status });

        await expect(
          store.turns.claim(runId, claimOptions("owner-b", 20))
        ).resolves.toEqual({ ok: false, reason: "leased" });
      }
    );

    it("keeps a live running lease and rejects recovery claims", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun("run-live"));
      const claimed = await claim(store, "run-live", "owner-a", 10);
      await store.turns.update({ ...claimed, status: "running" });
      await expect(
        store.turns.claim("run-live", claimOptions("owner-b", 20))
      ).resolves.toEqual({ ok: false, reason: "leased" });

      const recovery = await store.turns.create(
        createQueuedRun("run-recovery")
      );
      await store.turns.update({
        ...recovery.record,
        status: "needs-recovery",
      });
      await expect(
        store.turns.claim("run-recovery", claimOptions("owner", 10))
      ).resolves.toEqual({ ok: false, reason: "not-claimable" });
    });

    it("replaces a live lease only when the claim names it abandoned", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun("run-abandoned"));
      const claimed = await claim(store, "run-abandoned", "owner-a", 10);
      await store.turns.update({ ...claimed, status: "running" });

      await expect(
        store.turns.claim("run-abandoned", {
          ...claimOptions("owner-b", 20),
          abandonedLeaseId: "another-lease",
        })
      ).resolves.toEqual({ ok: false, reason: "leased" });
      await expect(
        store.turns.claim("run-abandoned", {
          ...claimOptions("owner-b", 20),
          abandonedLeaseId: "owner-a",
        })
      ).resolves.toMatchObject({ lease: { leaseId: "owner-b" }, ok: true });
    });

    it("keeps the lease owner through claims and lease renewals", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun("run-owner"));
      const owner = {
        bootId: "boot-a",
        hostname: "host-a",
        id: "process-a",
        pid: 41,
        pidNamespace: "pid:[4026531836]",
        processStart: "1234",
      };
      const claimed = await store.turns.claim("run-owner", {
        ...claimOptions("owner-a", 10),
        owner,
      });
      if (!claimed.ok) {
        throw new Error("Expected owner A to claim run-owner.");
      }

      const renewed = await transitionTurn(store.turns, {
        expected: { leaseId: "owner-a", status: "leased" },
        runId: "run-owner",
        update: {
          lease: { ...claimed.lease, leaseUntilMs: 5000 },
          status: "running",
        },
      });

      expect(renewed.ok).toBe(true);
      await expect(store.turns.get("run-owner")).resolves.toMatchObject({
        lease: { leaseId: "owner-a", leaseUntilMs: 5000, owner },
        status: "running",
      });
    });

    it.each([
      "cancelled",
      "completed",
      "error",
      "needs-recovery",
    ] satisfies readonly TurnStatus[])(
      "reports non-claimable %s before considering stale lease data",
      async (status) => {
        const store = createStore();
        const runId = `run-live-${status}`;
        await store.turns.create(createQueuedRun(runId));
        const claimed = await claim(store, runId, "owner-a", 10);
        await store.turns.update({ ...claimed, status });

        await expect(
          store.turns.claim(runId, claimOptions("owner-b", 20))
        ).resolves.toEqual({ ok: false, reason: "not-claimable" });
      }
    );

    it("parks a repeatedly claimed run into needs-recovery when maxAttempts is exceeded", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun("run-crash-loop"));

      const first = await store.turns.claim("run-crash-loop", {
        attempt: 1,
        leaseId: "worker-1",
        leaseMs: 50,
        maxAttempts: 2,
        nowMs: 10,
      });
      expect(first.ok).toBe(true);

      const second = await store.turns.claim("run-crash-loop", {
        attempt: 2,
        leaseId: "worker-2",
        leaseMs: 50,
        maxAttempts: 2,
        nowMs: 100,
      });
      expect(second.ok).toBe(true);

      const third = await store.turns.claim("run-crash-loop", {
        attempt: 3,
        leaseId: "worker-3",
        leaseMs: 50,
        maxAttempts: 2,
        nowMs: 200,
      });
      expect(third).toEqual({ ok: false, reason: "not-claimable" });

      const parked = await store.turns.get("run-crash-loop");
      expect(parked?.status).toBe("needs-recovery");
      expect(parked?.lease).toBeUndefined();
    });

    it("preserves current identity and checkpoint fields for a status transition", async () => {
      const store = createStore();
      const original = {
        ...createQueuedRun("run-checkpoint-race"),
        dedupeKey: "dedupe-checkpoint-race",
        ownerNamespace: "owner-namespace",
        parentRunId: "parent-run",
        publicTaskId: "public-task",
      };
      await store.turns.create(original);
      const claimed = await claim(store, original.runId, "owner", 10);
      await appendCheckpoint(store, original.runId);

      await expect(
        transitionTurn(store.turns, {
          expected: { leaseId: "owner", status: "leased" },
          runId: original.runId,
          update: { status: "completed" },
        })
      ).resolves.toEqual({
        ok: true,
        record: { ...claimed, checkpointVersion: 1, status: "completed" },
      });
    });

    it("rejects an explicit stale checkpoint expectation", async () => {
      const store = createStore();
      const original = createQueuedRun("run-expected-checkpoint");
      await store.turns.create(original);
      const claimed = await claim(store, original.runId, "owner", 10);
      await appendCheckpoint(store, original.runId);

      await expect(
        transitionTurn(store.turns, {
          expected: {
            checkpointVersion: 0,
            leaseId: "owner",
            status: "leased",
          },
          runId: original.runId,
          update: { status: "completed" },
        })
      ).resolves.toEqual({ ok: false, reason: "checkpoint-conflict" });
      await expect(store.turns.get(original.runId)).resolves.toEqual({
        ...claimed,
        checkpointVersion: 1,
      });
    });

    it("clears only the lease when the transition lease is null", async () => {
      const store = createStore();
      const original = createQueuedRun("run-clear-lease");
      await store.turns.create(original);
      const claimed = await claim(store, original.runId, "owner", 10);
      const { lease: _lease, ...withoutLease } = claimed;

      await expect(
        transitionTurn(store.turns, {
          expected: { leaseId: "owner", status: "leased" },
          runId: original.runId,
          update: { lease: null, status: "queued" },
        })
      ).resolves.toEqual({
        ok: true,
        record: { ...withoutLease, status: "queued" },
      });
    });

    it("rejects stale-owner transitions and checkpoints", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun("run-fenced"));
      const first = await claim(store, "run-fenced", "owner-a", 10);
      await store.turns.update({ ...first, status: "running" });
      const second = await claim(store, "run-fenced", "owner-b", 200);

      await expect(
        transitionTurn(store.turns, {
          expected: { leaseId: "owner-a", status: "leased" },
          runId: "run-fenced",
          update: { lease: null, status: "completed" },
        })
      ).resolves.toEqual({ ok: false, reason: "lease-conflict" });
      await expect(
        fencedCheckpoints(store).appendFenced(
          {
            checkpointId: "checkpoint-fenced",
            phase: "before-model",
            runId: "run-fenced",
            runtimeState: {},
            threadSnapshot: {},
            version: 1,
          },
          { expectedLeaseId: "owner-a", expectedVersion: 0 }
        )
      ).resolves.toEqual({ ok: false, reason: "lease-conflict" });
      await expect(store.turns.get("run-fenced")).resolves.toEqual(second);
      await expect(store.checkpoints.latest("run-fenced")).resolves.toBeNull();
    });
  });
}

async function appendCheckpoint(
  store: HostStore,
  runId: string
): Promise<void> {
  await expect(
    fencedCheckpoints(store).appendFenced(
      {
        checkpointId: `checkpoint-${runId}`,
        phase: "before-model",
        runId,
        runtimeState: {},
        threadSnapshot: {},
        version: 1,
      },
      { expectedLeaseId: "owner", expectedVersion: 0 }
    )
  ).resolves.toEqual({ ok: true, version: 1 });
}

function fencedCheckpoints(store: HostStore) {
  const capability = store.leaseFencedCheckpoints;
  if (!capability) {
    throw new Error("First-party store lacks checkpoint fencing.");
  }
  return capability;
}

function claimOptions(leaseId: string, nowMs: number) {
  return { attempt: 1, leaseId, leaseMs: 100, nowMs };
}

async function claim(
  store: HostStore,
  runId: string,
  leaseId: string,
  nowMs: number
) {
  const result = await store.turns.claim(runId, claimOptions(leaseId, nowMs));
  if (!result.ok) {
    throw new Error(`Expected ${leaseId} to claim ${runId}.`);
  }
  return result.record;
}
