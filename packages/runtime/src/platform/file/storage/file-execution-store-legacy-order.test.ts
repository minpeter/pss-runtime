import { cp, readFile, utimes, writeFile } from "node:fs/promises";
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
  GENERATIONS_DIRECTORY,
  writeCurrentGeneration,
} from "./file-execution-store/generation";
import {
  base64Url,
  checkpointRecord,
  currentDataDirectory,
  runRecord,
  tempDir,
} from "./file-execution-store-test-support";

const LEGACY_EPOCH_SECONDS = 1_700_000_000;

const legacyStatuses: readonly (readonly [string, TurnRecord["status"]])[] = [
  ["run-a", "completed"],
  ["run-b", "running"],
  ["run-c", "error"],
  ["run-d", "queued"],
  ["run-e", "needs-recovery"],
  ["run-f", "cancelled"],
];

// Unsettled legacy runs first, then settled ones, each group by runId.
const expectedLegacyOrder = [
  "run-b",
  "run-d",
  "run-a",
  "run-c",
  "run-e",
  "run-f",
];

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

/**
 * Writes run files in origin/main format. Each file's mtime is set from
 * `mtimeRank` so that file metadata contradicts the expected order.
 */
async function writeRunFiles(
  dataDirectory: string,
  files: readonly {
    readonly mtimeRank: number;
    readonly record: StoredRunRecord;
  }[]
): Promise<void> {
  for (const { mtimeRank, record } of files) {
    const file = runFile(dataDirectory, record.runId);
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    const mtimeSeconds = LEGACY_EPOCH_SECONDS + mtimeRank * 60;
    await utimes(file, mtimeSeconds, mtimeSeconds);
  }
}

async function createEmptyStore(): Promise<{
  readonly dataDirectory: string;
  readonly directory: string;
  readonly store: FileExecutionStore;
}> {
  const directory = await tempDir();
  const store = new FileExecutionStore(directory);
  await store.turns.create(runRecord("seed", { threadKey: "seed-thread" }));
  return {
    dataDirectory: await currentDataDirectory(directory),
    directory,
    store,
  };
}

async function createStoreWithLegacyRuns(): Promise<{
  readonly directory: string;
  readonly store: FileExecutionStore;
}> {
  const { dataDirectory, directory, store } = await createEmptyStore();
  await writeRunFiles(
    dataDirectory,
    legacyStatuses.map(([runId, status]) => ({
      // Newest mtime for the run expected first.
      mtimeRank: -expectedLegacyOrder.indexOf(runId),
      record: runRecord(runId, { status }),
    }))
  );
  return { directory, store };
}

/**
 * Commits a generation the way origin/main did: a copy that does not preserve
 * timestamps, so every run file's mtime becomes arbitrary.
 */
async function copyGenerationLikeOriginMain(directory: string): Promise<void> {
  const source = await currentDataDirectory(directory);
  const generationId = "origin-main-copy";
  const target = join(directory, GENERATIONS_DIRECTORY, generationId);
  await cp(source, target, { recursive: true });
  for (const [index, [runId]] of legacyStatuses.entries()) {
    const mtimeSeconds = LEGACY_EPOCH_SECONDS + ((index * 7) % 5) * 60;
    await utimes(runFile(target, runId), mtimeSeconds, mtimeSeconds);
  }
  await writeCurrentGeneration(directory, generationId);
}

describe("FileExecutionStore legacy run ordering", () => {
  it("orders legacy runs before modern ones, unsettled before settled, ignoring file times", async () => {
    // Given legacy runs whose mtimes reverse the expected order, and a modern
    // run created after the upgrade with the lexically smallest runId
    const { store } = await createStoreWithLegacyRuns();
    await store.turns.create(runRecord("run-0-modern"));

    // When the thread runs are listed
    // Then legacy runs come first, unsettled before settled, by runId
    await expect(listThreadRuns(store)).resolves.toEqual([
      ...expectedLegacyOrder,
      "run-0-modern",
    ]);
  });

  it("keeps a rewritten legacy run in the legacy group with a persisted marker", async () => {
    // Given legacy runs and a modern run
    const { directory, store } = await createStoreWithLegacyRuns();
    await store.turns.create(runRecord("run-0-modern"));

    // When an unsettled legacy run is rewritten as completed
    await store.turns.update(runRecord("run-b", { status: "completed" }));

    // Then it persists the legacy marker and moves among settled legacy runs,
    // never after the modern run
    expect((await readStoredRun(directory, "run-b")).createdOrder).toBe(0);
    await expect(listThreadRuns(store)).resolves.toEqual([
      "run-d",
      "run-a",
      "run-b",
      "run-c",
      "run-e",
      "run-f",
      "run-0-modern",
    ]);
  });

  it("keeps order across store.transaction() and origin/main-style copies", async () => {
    // Given legacy runs and a modern run
    const { directory, store } = await createStoreWithLegacyRuns();
    await store.turns.create(runRecord("run-0-modern"));
    const expected = [...expectedLegacyOrder, "run-0-modern"];

    // When an unrelated transaction commits a new generation
    await store.transaction(async (tx) => {
      await tx.turns.create(runRecord("other", { threadKey: "other-thread" }));
    });

    // Then the order is unchanged
    await expect(listThreadRuns(store)).resolves.toEqual(expected);

    // When a generation is copied without preserving file times
    await copyGenerationLikeOriginMain(directory);

    // Then the order is still unchanged
    await expect(listThreadRuns(store)).resolves.toEqual(expected);
  });

  it("keeps a persisted createdOrder over mtime and runId", async () => {
    // Given run files whose persisted createdOrder contradicts both their
    // mtime order and their lexical runId order
    const { dataDirectory, store } = await createEmptyStore();
    await writeRunFiles(dataDirectory, [
      {
        mtimeRank: 0,
        record: { ...runRecord("run-a-persisted-third"), createdOrder: 3000 },
      },
      {
        mtimeRank: 1,
        record: { ...runRecord("run-m-persisted-second"), createdOrder: 2000 },
      },
      {
        mtimeRank: 2,
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

    // Then it persists a real creation order that sorts after legacy runs
    expect(
      (await readStoredRun(directory, "run-0-upserted")).createdOrder
    ).toBeGreaterThan(0);
    await expect(listThreadRuns(store)).resolves.toEqual([
      ...expectedLegacyOrder,
      "run-0-upserted",
    ]);
  });
});

describe("FileExecutionStore legacy runs during recovery", () => {
  async function createLegacyThread(
    threadKey: string,
    files: readonly {
      readonly mtimeRank: number;
      readonly record: StoredRunRecord;
    }[]
  ): Promise<{
    readonly calls: () => number;
    readonly restarted: Agent;
    readonly store: FileExecutionStore;
  }> {
    const { dataDirectory, store } = await createEmptyStore();
    await writeRunFiles(dataDirectory, files);
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

  it("thread.continue() does not resume a stale crashed legacy run once a legacy run completed", async () => {
    // Given a completed legacy run and an older crashed legacy run whose file
    // time and runId both look newer
    const threadKey = "legacy-stale";
    const { calls, restarted, store } = await createLegacyThread(threadKey, [
      {
        mtimeRank: 0,
        record: runRecord("legacy-a-completed", {
          status: "completed",
          threadKey,
        }),
      },
      {
        mtimeRank: 1,
        record: runRecord("legacy-z-crashed", { status: "running", threadKey }),
      },
    ]);

    // When a restarted agent continues the thread
    const turn = await restarted.thread(threadKey).continue();

    // Then nothing is recovered
    expect(turn).toBeUndefined();
    expect(calls()).toBe(0);
    await expect(store.turns.get("legacy-z-crashed")).resolves.toMatchObject({
      status: "running",
    });
  });

  it("thread.continue() recovers a crashed legacy run when no legacy run settled", async () => {
    // Given a single crashed legacy run
    const threadKey = "legacy-crashed";
    const { calls, restarted, store } = await createLegacyThread(threadKey, [
      {
        mtimeRank: 0,
        record: runRecord("legacy-crashed-r0", {
          status: "running",
          threadKey,
        }),
      },
    ]);

    // When a restarted agent continues the thread
    const turn = await restarted.thread(threadKey).continue();

    // Then the crashed run is recovered
    if (!turn) {
      throw new Error("Expected thread.continue() to recover the legacy run.");
    }
    expect(eventTypes(await collect(turn))).toContain("turn-end");
    expect(calls()).toBe(1);
    await expect(store.turns.get("legacy-crashed-r0")).resolves.toMatchObject({
      status: "completed",
    });
  });
});
