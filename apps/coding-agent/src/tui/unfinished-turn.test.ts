import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TurnLeaseOwner,
  TurnStatus,
} from "@minpeter/pss-runtime/execution";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findUnfinishedTurn } from "./unfinished-turn";

const SESSION = "cwd:/work#session";
const NOW_MS = Date.now();
/** Above every platform's pid limit, so no process can have it. */
const DEAD_PID = 2 ** 22 + 1;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pss-unfinished-turn-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("findUnfinishedTurn", () => {
  it("reports a turn whose process died as interrupted before its lease lapses", async () => {
    // Given: the session's turn is leased to a process that no longer exists.
    const host = createFileHost({ directory });
    await seedRun(host, "running", { pid: DEAD_PID });

    // When / Then: it can be continued now.
    await expect(findUnfinishedTurn(host, SESSION, NOW_MS)).resolves.toEqual({
      kind: "interrupted",
    });
  });

  it("reports a turn of a live process as running elsewhere until its lease lapses", async () => {
    // Given: the session's turn is leased to another live process.
    const host = createFileHost({ directory });
    await seedRun(host, "running", { pid: process.ppid });

    // When: the session is checked before and after the lease deadline.
    const live = await findUnfinishedTurn(host, SESSION, NOW_MS);
    const lapsed = await findUnfinishedTurn(host, SESSION, NOW_MS + 60_000);

    // Then: only the lapsed lease lets the turn be continued.
    expect(live).toEqual({ kind: "running-elsewhere", pid: process.ppid });
    expect(lapsed).toEqual({ kind: "interrupted" });
  });

  it("reports a turn that died inside an undecided manual-recovery call as needing a decision", async () => {
    // Given: the dead turn's journal holds a manual-recovery call without
    // an outcome or a decision.
    const host = createFileHost({ directory });
    await seedRun(host, "running", { pid: DEAD_PID });
    const transfer = {
      attempt: 1,
      idempotencyKey: "run-1:call_transfer",
      policy: "manual-recovery",
      toolCallId: "call_transfer",
      toolName: "transfer",
    } as const;
    await host.store.checkpoints.append(
      {
        checkpointId: "before-transfer",
        pendingToolCall: transfer,
        phase: "before-tool",
        runId: "run-1",
        runtimeState: {
          inflight: [{ ...transfer, input: {}, seq: 1 }],
          journalVersion: 2,
          results: [],
          toolCallId: transfer.toolCallId,
          toolName: transfer.toolName,
        },
        threadSnapshot: { history: [] },
        version: 1,
      },
      { expectedVersion: 0 }
    );

    // When / Then: continuing it waits for a decision about that call.
    await expect(findUnfinishedTurn(host, SESSION, NOW_MS)).resolves.toEqual({
      kind: "needs-decision",
      toolName: "transfer",
    });
  });

  it("reports nothing once the session's last turn settled", async () => {
    // Given: the session's last turn completed.
    const host = createFileHost({ directory });
    await seedRun(host, "completed");

    // When / Then: there is nothing to go on from.
    await expect(
      findUnfinishedTurn(host, SESSION, NOW_MS)
    ).resolves.toBeUndefined();
  });
});

async function seedRun(
  host: ReturnType<typeof createFileHost>,
  status: TurnStatus,
  owner?: Pick<TurnLeaseOwner, "pid">
): Promise<void> {
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    ...(owner === undefined
      ? {}
      : {
          lease: {
            attempt: 1,
            leaseId: "lease-1",
            leaseUntilMs: NOW_MS + 30_000,
            owner: { hostname: hostname(), id: "other-process", ...owner },
          },
        }),
    rootRunId: "run-1",
    runId: "run-1",
    status,
    threadKey: SESSION,
  });
}
