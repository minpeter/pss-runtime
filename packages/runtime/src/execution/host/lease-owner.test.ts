import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { startThreadExecutionRun } from "../../thread/runtime/execution";
import { ThreadState } from "../../thread/state/thread-state";
import { abandonedLeaseId } from "./lease-owner";

describe("abandoned leases of this process", () => {
  it("frees a running run once no turn in this process runs it", async () => {
    // Given: a run this process started.
    const host = createInMemoryHost();
    const runId = "own-run";
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "thread",
    });
    const execution = await startThreadExecutionRun({
      executionHost: host,
      executionRun: { kind: "user-turn", runId },
      state: new ThreadState({ key: "thread", store: host.store.threads }),
      threadKey: "thread",
      turnId: "unused",
    });
    const running = await host.store.turns.get(runId);
    if (!(execution && running?.lease)) {
      throw new Error("Expected a leased running run.");
    }
    const whileRunning = abandonedLeaseId(running, undefined);

    // When: its turn stops without settling the run, as after a failed
    // terminal commit.
    execution.release();

    // Then: only now may this process reclaim it before the lease lapses.
    expect(whileRunning).toBeUndefined();
    expect(abandonedLeaseId(running, undefined)).toBe(running.lease.leaseId);
  });

  it("keeps a claimed run that has not started yet", () => {
    // Given: a run this process claimed but has not started.
    const claimed = {
      checkpointVersion: 0,
      kind: "user-turn" as const,
      lease: {
        attempt: 2,
        leaseId: "claimed",
        leaseUntilMs: Date.now() + 1000,
        owner: { id: "another-process" },
      },
      rootRunId: "claimed-run",
      runId: "claimed-run",
      status: "leased" as const,
      threadKey: "thread",
    };

    // When / Then: without proof its owner is gone, it stays leased.
    expect(abandonedLeaseId(claimed, undefined)).toBeUndefined();
    expect(abandonedLeaseId(claimed, { isGone: () => false })).toBeUndefined();
    expect(abandonedLeaseId(claimed, { isGone: () => true })).toBe("claimed");
  });
});
