import { readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TurnRecord } from "../../../execution/host/types";
import { FileExecutionStore } from "./file-execution-store";
import {
  base64Url,
  currentDataDirectory,
  runRecord,
  tempDir,
} from "./file-execution-store-test-support";

// Creation order deliberately disagrees with lexical runId order, so neither
// readdir order nor a runId tie-break can produce the expected listing.
const legacyRunIds = [
  "run-k",
  "run-c",
  "run-x",
  "run-a",
  "run-q",
  "run-f",
  "run-y",
  "run-b",
  "run-m",
  "run-e",
  "run-t",
  "run-h",
];

function runFile(dataDirectory: string, runId: string): string {
  return join(dataDirectory, "runs", `${base64Url(runId)}.json`);
}

async function listThreadRuns(
  store: FileExecutionStore
): Promise<readonly TurnRecord[]> {
  if (!store.turns.listByThreadKey) {
    throw new Error("FileExecutionStore must list runs by thread.");
  }
  return await store.turns.listByThreadKey("thread-1");
}

/**
 * Writes run files in array order with strictly increasing file time: birth
 * time where the filesystem records it (recreating a file until the coarse
 * filesystem clock advances past its predecessor), and an mtime that follows
 * the same order for filesystems without birth time.
 */
async function createRunFilesInOrder(
  dataDirectory: string,
  records: readonly (TurnRecord & { readonly createdOrder?: number })[]
): Promise<void> {
  let previousBirthtimeMs = 0;
  for (const [index, record] of records.entries()) {
    const file = runFile(dataDirectory, record.runId);
    let birthtimeMs = 0;
    do {
      await rm(file, { force: true });
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
      ({ birthtimeMs } = await stat(file));
    } while (birthtimeMs > 0 && birthtimeMs <= previousBirthtimeMs);
    previousBirthtimeMs = birthtimeMs;
    const fileTimeSeconds = 1_700_000_000 + index * 60;
    await utimes(file, fileTimeSeconds, fileTimeSeconds);
  }
}

async function dataDirectoryFor(
  store: FileExecutionStore,
  directory: string
): Promise<string> {
  await store.turns.create(runRecord("seed", { threadKey: "seed-thread" }));
  return await currentDataDirectory(directory);
}

describe("FileExecutionStore legacy run ordering", () => {
  it("orders runs without createdOrder by file time and keeps that order after rewrites", async () => {
    // Given run files in origin/main format (no createdOrder) created in an
    // order that differs from their lexical runId order
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    const dataDirectory = await dataDirectoryFor(store, directory);
    await createRunFilesInOrder(
      dataDirectory,
      legacyRunIds.map((runId) => runRecord(runId, { status: "completed" }))
    );

    // When the thread runs are listed
    const listed = await listThreadRuns(store);

    // Then they come back in creation order, not readdir or runId order
    expect(listed.map((record) => record.runId)).toEqual(legacyRunIds);

    // When the oldest legacy run is rewritten and a modern run is created
    await store.turns.update(
      runRecord("run-k", { output: "rewritten", status: "completed" })
    );
    await store.turns.create(runRecord("run-zz-modern"));

    // Then the rewrite persists the fallback order instead of moving the run
    const rewritten = JSON.parse(
      await readFile(runFile(dataDirectory, "run-k"), "utf8")
    ) as { readonly createdOrder?: unknown };
    expect(typeof rewritten.createdOrder).toBe("number");
    const relisted = await listThreadRuns(store);
    expect(relisted.map((record) => record.runId)).toEqual([
      ...legacyRunIds,
      "run-zz-modern",
    ]);
  });

  it("keeps a persisted createdOrder over file time and runId", async () => {
    // Given modern run files whose persisted createdOrder contradicts both
    // their file creation order and their lexical runId order
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    const dataDirectory = await dataDirectoryFor(store, directory);
    await createRunFilesInOrder(dataDirectory, [
      { ...runRecord("run-a-persisted-third"), createdOrder: 3000 },
      { ...runRecord("run-m-persisted-second"), createdOrder: 2000 },
      { ...runRecord("run-z-persisted-first"), createdOrder: 1000 },
    ]);

    // When the thread runs are listed
    const listed = await listThreadRuns(store);

    // Then persisted creation order wins over file metadata and runId
    expect(listed.map((record) => record.runId)).toEqual([
      "run-z-persisted-first",
      "run-m-persisted-second",
      "run-a-persisted-third",
    ]);
  });
});
