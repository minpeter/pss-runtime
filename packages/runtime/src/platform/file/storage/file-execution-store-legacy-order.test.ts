import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../../agent/core/agent";
import { createAgent } from "../../../agent/core/agent";
import type { TurnRecord } from "../../../execution/host/types";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
} from "../../../testing/test-fixtures";
import { collect } from "../../../thread/handle/test-support";
import { encodeThreadSnapshot } from "../../../thread/state/snapshot";
import { createInMemoryHost } from "../../memory";
import { FileExecutionStore } from "./file-execution-store";
import {
  base64Url,
  checkpointRecord,
  currentDataDirectory,
  runRecord,
  tempDir,
} from "./file-execution-store-test-support";

const LEGACY_EPOCH_SECONDS = 1_700_000_000;

// Files are created in `creation` order but their mtimes follow `mtimeOrder`;
// both disagree with lexical runId order, so only an mtime-based fallback
// yields `mtimeOrder`.
const legacyRuns = {
  creation: ["run-m", "run-a", "run-z", "run-c"],
  mtimeOrder: ["run-z", "run-m", "run-c", "run-a"],
} as const;

type StoredRunRecord = TurnRecord & { readonly createdOrder?: number };

function runFile(dataDirectory: string, runId: string): string {
  return join(dataDirectory, "runs", `${base64Url(runId)}.json`);
}

async function listThreadRuns(
  store: FileExecutionStore,
  threadKey = "thread-1"
): Promise<readonly string[]> {
  if (!store.turns.listByThreadKey) {
    throw new Error("FileExecutionStore must list runs by thread.");
  }
  return (await store.turns.listByThreadKey(threadKey)).map(
    (record) => record.runId
  );
}

async function readStoredRun(
  directory: string,
  runId: string
): Promise<StoredRunRecord> {
  return JSON.parse(
    await readFile(
      runFile(await currentDataDirectory(directory), runId),
      "utf8"
    )
  ) as StoredRunRecord;
}

/** Writes run files in origin/main format with an explicit mtime each. */
async function writeRunFiles(
  dataDirectory: string,
  files: readonly {
    readonly mtimeSeconds: number;
    readonly record: StoredRunRecord;
  }[]
): Promise<void> {
  for (const { mtimeSeconds, record } of files) {
    const file = runFile(dataDirectory, record.runId);
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    await utimes(file, mtimeSeconds, mtimeSeconds);
  }
}

async function createStoreWithLegacyRuns(): Promise<{
  readonly directory: string;
  readonly store: FileExecutionStore;
}> {
  const directory = await tempDir();
  const store = new FileExecutionStore(directory);
  await store.turns.create(runRecord("seed", { threadKey: "seed-thread" }));
  await writeRunFiles(
    await currentDataDirectory(directory),
    legacyRuns.creation.map((runId) => ({
      mtimeSeconds:
        LEGACY_EPOCH_SECONDS + legacyRuns.mtimeOrder.indexOf(runId) * 60,
      record: runRecord(runId, { status: "completed" }),
    }))
  );
  return { directory, store };
}

describe("FileExecutionStore legacy run ordering", () => {
  it("orders runs without createdOrder by mtime, not file creation or runId", async () => {
    // Given legacy run files whose creation, mtime, and lexical orders differ
    const { directory, store } = await createStoreWithLegacyRuns();

    // When the thread runs are listed
    // Then they follow mtime order
    await expect(listThreadRuns(store)).resolves.toEqual(legacyRuns.mtimeOrder);

    // When the oldest legacy run is rewritten and a modern run is created
    await store.turns.update(
      runRecord("run-z", { output: "rewritten", status: "completed" })
    );
    await store.turns.create(runRecord("run-0-modern"));

    // Then the rewrite persists its fallback order and the modern run sorts last
    expect(typeof (await readStoredRun(directory, "run-z")).createdOrder).toBe(
      "number"
    );
    await expect(listThreadRuns(store)).resolves.toEqual([
      ...legacyRuns.mtimeOrder,
      "run-0-modern",
    ]);
  });

  it("keeps legacy and modern order across store.transaction()", async () => {
    // Given legacy runs and a modern run created after the upgrade
    const { store } = await createStoreWithLegacyRuns();
    await store.turns.create(runRecord("run-0-modern"));

    // When an unrelated transaction copies the data directory
    await store.transaction(async (tx) => {
      await tx.turns.create(runRecord("other", { threadKey: "other-thread" }));
    });

    // Then the copied legacy files keep their order before the modern run
    await expect(listThreadRuns(store)).resolves.toEqual([
      ...legacyRuns.mtimeOrder,
      "run-0-modern",
    ]);
  });

  it("keeps legacy and modern order across store.checkpoints.append()", async () => {
    // Given legacy runs and a modern run created after the upgrade
    const { store } = await createStoreWithLegacyRuns();
    await store.turns.create(runRecord("run-0-modern"));

    // When a checkpoint append commits a new generation
    await store.checkpoints.append(checkpointRecord("seed", 1), {
      expectedVersion: 0,
    });

    // Then the copied legacy files keep their order before the modern run
    await expect(listThreadRuns(store)).resolves.toEqual([
      ...legacyRuns.mtimeOrder,
      "run-0-modern",
    ]);
  });

  it("keeps a persisted createdOrder over mtime and runId", async () => {
    // Given run files whose persisted createdOrder contradicts both their
    // mtime order and their lexical runId order
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord("seed", { threadKey: "seed-thread" }));
    await writeRunFiles(await currentDataDirectory(directory), [
      {
        mtimeSeconds: LEGACY_EPOCH_SECONDS,
        record: { ...runRecord("run-a-persisted-third"), createdOrder: 3000 },
      },
      {
        mtimeSeconds: LEGACY_EPOCH_SECONDS + 60,
        record: { ...runRecord("run-m-persisted-second"), createdOrder: 2000 },
      },
      {
        mtimeSeconds: LEGACY_EPOCH_SECONDS + 120,
        record: { ...runRecord("run-z-persisted-first"), createdOrder: 1000 },
      },
    ]);

    // When the thread runs are listed
    // Then persisted creation order wins over file metadata and runId
    await expect(listThreadRuns(store)).resolves.toEqual([
      "run-z-persisted-first",
      "run-m-persisted-second",
      "run-a-persisted-third",
    ]);
  });

  it("persists createdOrder when update() creates a run", async () => {
    // Given legacy runs
    const { directory, store } = await createStoreWithLegacyRuns();

    // When update() writes a run that did not exist
    await store.turns.update(runRecord("run-0-upserted"));

    // Then it persists a creation order that sorts after the legacy runs
    expect(
      typeof (await readStoredRun(directory, "run-0-upserted")).createdOrder
    ).toBe("number");
    await expect(listThreadRuns(store)).resolves.toEqual([
      ...legacyRuns.mtimeOrder,
      "run-0-upserted",
    ]);
  });
});

describe("FileExecutionStore legacy runs during recovery", () => {
  async function createCrashedModernRun(threadKey: string): Promise<{
    readonly calls: () => number;
    readonly restarted: Agent;
    readonly store: FileExecutionStore;
  }> {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord("seed", { threadKey: "seed-thread" }));
    await writeRunFiles(await currentDataDirectory(directory), [
      {
        mtimeSeconds: LEGACY_EPOCH_SECONDS,
        record: runRecord("legacy-r0", { status: "completed", threadKey }),
      },
    ]);
    await store.threads.commit(
      threadKey,
      {
        state: encodeThreadSnapshot([
          { content: "old", role: "user" },
          { content: "old reply", role: "assistant" },
          { content: "new", role: "user" },
        ]),
      },
      { expectedVersion: null }
    );
    await store.turns.create(
      runRecord("modern-r1", { status: "running", threadKey })
    );
    // Another thread's checkpoint commits a new generation after the crash.
    await store.checkpoints.append(checkpointRecord("seed", 1), {
      expectedVersion: 0,
    });
    let calls = 0;
    const model = createCallbackModel(() => {
      calls += 1;
      return Promise.resolve([assistantMessage("RECOVERED")]);
    });
    return {
      calls: () => calls,
      restarted: await createAgent({
        host: { ...createInMemoryHost(), store },
        model,
      }),
      store,
    };
  }

  it("agent.resume() resumes a crashed modern run instead of cancelling it", async () => {
    // Given an upgraded thread: a completed legacy run, then a crashed modern run
    const { calls, restarted, store } =
      await createCrashedModernRun("legacy-resume");

    // When a restarted agent resumes the modern run
    const resumed = await restarted.resume("modern-r1");

    // Then it replies instead of being cancelled as superseded
    if (!resumed) {
      throw new Error("Expected the crashed modern run to resume.");
    }
    expect(eventTypes(await collect(resumed))).toContain("turn-end");
    expect(calls()).toBe(1);
    await expect(store.turns.get("modern-r1")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("thread.continue() recovers a crashed modern run after a legacy run", async () => {
    // Given an upgraded thread: a completed legacy run, then a crashed modern run
    const { calls, restarted, store } =
      await createCrashedModernRun("legacy-continue");

    // When a restarted agent continues the thread
    const turn = await restarted.thread("legacy-continue").continue();

    // Then the modern run is recovered
    if (!turn) {
      throw new Error("Expected thread.continue() to recover the modern run.");
    }
    expect(eventTypes(await collect(turn))).toContain("turn-end");
    expect(calls()).toBe(1);
    await expect(store.turns.get("modern-r1")).resolves.toMatchObject({
      status: "completed",
    });
  });
});
