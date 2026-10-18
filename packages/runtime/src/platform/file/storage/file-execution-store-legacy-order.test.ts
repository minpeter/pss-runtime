import { readFile, utimes, writeFile } from "node:fs/promises";
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

const legacyRunIds = Array.from(
  { length: 12 },
  (_, index) => `run-${String(index).padStart(2, "0")}`
);

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

async function writeLegacyRuns(
  store: FileExecutionStore,
  directory: string
): Promise<string> {
  await store.turns.create(runRecord("seed", { threadKey: "seed-thread" }));
  const dataDirectory = await currentDataDirectory(directory);
  for (const [index, runId] of legacyRunIds.entries()) {
    // origin/main wrote run files without `createdOrder`.
    const legacyRecord: TurnRecord = runRecord(runId, { status: "completed" });
    const file = runFile(dataDirectory, runId);
    await writeFile(file, `${JSON.stringify(legacyRecord, null, 2)}\n`);
    const fileTimeSeconds = 1_700_000_000 + index * 60;
    await utimes(file, fileTimeSeconds, fileTimeSeconds);
  }
  return dataDirectory;
}

describe("FileExecutionStore legacy run ordering", () => {
  it("orders runs without createdOrder by file time and keeps that order after rewrites", async () => {
    // Given run files rewritten in origin/main format, written oldest first
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    const dataDirectory = await writeLegacyRuns(store, directory);

    // When the thread runs are listed
    const listed = await listThreadRuns(store);

    // Then they come back in creation order, not readdir order
    expect(listed.map((record) => record.runId)).toEqual(legacyRunIds);

    // When the oldest legacy run is rewritten and a modern run is created
    await store.turns.update(
      runRecord("run-00", { output: "rewritten", status: "completed" })
    );
    await store.turns.create(runRecord("run-zz-modern"));

    // Then the rewrite persists the fallback order instead of moving the run
    const rewritten = JSON.parse(
      await readFile(runFile(dataDirectory, "run-00"), "utf8")
    ) as { readonly createdOrder?: unknown };
    expect(typeof rewritten.createdOrder).toBe("number");
    const relisted = await listThreadRuns(store);
    expect(relisted.map((record) => record.runId)).toEqual([
      ...legacyRunIds,
      "run-zz-modern",
    ]);
    expect(relisted.at(-1)?.runId).toBe("run-zz-modern");
  });

  it("keeps a persisted createdOrder regardless of file time", async () => {
    // Given two modern runs whose newer file is backdated
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord("run-b-first"));
    await store.turns.create(runRecord("run-a-second"));
    const dataDirectory = await currentDataDirectory(directory);
    await utimes(runFile(dataDirectory, "run-a-second"), 1, 1);

    // When the thread runs are listed
    const listed = await listThreadRuns(store);

    // Then persisted creation order wins over file metadata and runId
    expect(listed.map((record) => record.runId)).toEqual([
      "run-b-first",
      "run-a-second",
    ]);
  });
});
