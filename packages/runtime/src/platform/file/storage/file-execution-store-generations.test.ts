import type * as FsPromises from "node:fs/promises";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  HostScheduler,
  HostStoreTransaction,
  ThreadEventLog,
} from "../../../execution/host/types";
import { FileExecutionStore } from "./file-execution-store";
import {
  base64Url,
  checkpointRecord,
  collectEvents,
  collectThreadEvents,
  createDeferred,
  currentDataDirectory,
  notificationRecord,
  runRecord,
  tempDir,
} from "./file-execution-store-test-support";

const filesystem = vi.hoisted(
  (): { failingOpenPath?: string; linksRefused: boolean } => ({
    linksRefused: false,
  })
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const failure = (code: string) =>
    Promise.reject(Object.assign(new Error(`${code}: injected`), { code }));
  return {
    ...actual,
    // Lock files are published by linking a `.tmp` file; only data links are
    // refused, as on a filesystem without hard links.
    link: (existingPath: string, newPath: string) =>
      filesystem.linksRefused && !existingPath.endsWith(".tmp")
        ? failure("EPERM")
        : actual.link(existingPath, newPath),
    open: (...args: Parameters<typeof actual.open>) =>
      args[0] === filesystem.failingOpenPath
        ? failure("EIO")
        : actual.open(...args),
  };
});

const RUN_ID = "run:kept";
const THREAD_KEY = "thread:kept";

describe("FileExecutionStore generations", () => {
  it("keeps only the current generation after many committed transactions", async () => {
    // Given: a store with one run.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord(RUN_ID, { threadKey: THREAD_KEY }));

    // When: thirty commits go through every generation-publishing entry point.
    for (let version = 1; version <= 10; version += 1) {
      await store.checkpoints.append(checkpointRecord(RUN_ID, version), {
        expectedVersion: version - 1,
      });
      await store.transaction(async (tx) => {
        await threadEventsOf(tx).append(THREAD_KEY, { type: "turn-start" });
      });
      await store.deleteThread("thread:other");
    }

    // Then: one generation remains and it holds every committed write.
    await expect(readdir(join(directory, "generations"))).resolves.toEqual([
      basename(await currentDataDirectory(directory)),
    ]);
    await expect(store.checkpoints.latest(RUN_ID)).resolves.toEqual(
      checkpointRecord(RUN_ID, 10)
    );
    await expect(
      collectThreadEvents(store.threadEvents.read(THREAD_KEY))
    ).resolves.toHaveLength(10);
  });

  it("leaves the committed generation byte-identical when a linked transaction fails", async () => {
    // Given: every data directory holds committed records, and the next
    // transaction stages its generation by hard-linking them.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await seedCommittedRecords(store);
    const committed = await currentDataDirectory(directory);
    const before = await snapshotTree(committed);
    const eventsFile = join("events", `${base64Url(RUN_ID)}.jsonl`);
    let stagedEventsShareInode = false;

    // When: a transaction appends to, rewrites, and adds files, then fails.
    await expect(
      store.transaction(async (tx) => {
        const staged = await stagedGeneration(directory, committed);
        stagedEventsShareInode =
          (await stat(join(staged, eventsFile))).ino ===
          (await stat(join(committed, eventsFile))).ino;
        await tx.events.append(RUN_ID, { type: "turn-end" });
        await threadEventsOf(tx).append(THREAD_KEY, { type: "turn-end" });
        await tx.turns.update(
          runRecord(RUN_ID, { status: "running", threadKey: THREAD_KEY })
        );
        await tx.checkpoints.append(checkpointRecord(RUN_ID, 2), {
          expectedVersion: 1,
        });
        await tx.threads.commit(
          THREAD_KEY,
          { state: { value: "rolled back" } },
          { expectedVersion: "1" }
        );
        await tx.inputs.claimNext(THREAD_KEY, "turn-idle");
        await tx.notifications.claimByIdempotencyKey("notify:kept");
        await schedulerOf(tx).enqueueRun("run:rolled-back");
        throw new Error("rollback after linked writes");
      })
    ).rejects.toThrow("rollback after linked writes");

    // Then: the rollback could not reach the committed files through shared
    // inodes.
    expect(stagedEventsShareInode).toBe(true);
    await expect(currentDataDirectory(directory)).resolves.toBe(committed);
    await expect(snapshotTree(committed)).resolves.toEqual(before);
    await expect(readdir(join(directory, "generations"))).resolves.toEqual([
      basename(committed),
    ]);
  });

  it("copies files when the filesystem refuses hard links", async () => {
    // Given: committed records on a filesystem that refuses hard links.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await seedCommittedRecords(store);
    filesystem.linksRefused = true;
    try {
      const committed = await currentDataDirectory(directory);
      const before = await snapshotTree(committed);

      // When: one transaction fails and the next one commits.
      await expect(
        store.transaction(async (tx) => {
          await tx.events.append(RUN_ID, { type: "turn-end" });
          throw new Error("rollback on a copying filesystem");
        })
      ).rejects.toThrow("rollback on a copying filesystem");
      const afterRollback = await snapshotTree(committed);
      await store.transaction(async (tx) => {
        await tx.events.append(RUN_ID, { type: "step-start" });
      });

      // Then: the failure changed nothing and the commit kept every record.
      expect(afterRollback).toEqual(before);
      await expect(
        collectEvents(store.events.read(RUN_ID))
      ).resolves.toMatchObject([
        { event: { type: "turn-start" } },
        { event: { type: "step-start" } },
      ]);
      await expect(store.checkpoints.latest(RUN_ID)).resolves.toEqual(
        checkpointRecord(RUN_ID, 1)
      );
    } finally {
      filesystem.linksRefused = false;
    }
  });

  it("keeps the generation the pointer names when flushing its rename fails", async () => {
    // Given: a committed run and a store directory whose flush fails.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord(RUN_ID));
    filesystem.failingOpenPath = directory;
    try {
      // When: a transaction renames the pointer but cannot flush the rename.
      await expect(
        store.transaction(async (tx) => {
          await tx.turns.create(runRecord("run:published"));
        })
      ).rejects.toMatchObject({ code: "EIO" });
    } finally {
      filesystem.failingOpenPath = undefined;
    }

    // Then: the published generation stays readable and later commits work.
    await expect(store.turns.get("run:published")).resolves.toMatchObject({
      runId: "run:published",
    });
    await store.transaction(async (tx) => {
      await tx.turns.create(runRecord("run:later"));
    });
    await expect(store.turns.get(RUN_ID)).resolves.toMatchObject({
      runId: RUN_ID,
    });
    await expect(store.turns.get("run:published")).resolves.toMatchObject({
      runId: "run:published",
    });
  });

  it("sweeps a crashed transaction directory and superseded generations on the next commit", async () => {
    // Given: a crashed transaction directory and an old committed generation
    // beside the current one.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord(RUN_ID));
    const generations = join(directory, "generations");
    const crashed = join(generations, "transaction-2147483647-crashed");
    await mkdir(join(crashed, "runs"), { recursive: true });
    await writeFile(
      join(crashed, "runs", `${base64Url("run:ghost")}.json`),
      `${JSON.stringify(runRecord("run:ghost"))}\n`
    );
    await cp(
      await currentDataDirectory(directory),
      join(generations, "superseded"),
      { recursive: true }
    );

    // When: a transaction commits.
    await store.transaction(async (tx) => {
      await tx.turns.create(runRecord("run:next"));
    });

    // Then: only the new current generation is left, with committed records.
    await expect(readdir(generations)).resolves.toEqual([
      basename(await currentDataDirectory(directory)),
    ]);
    await expect(store.turns.get(RUN_ID)).resolves.toMatchObject({
      runId: RUN_ID,
    });
    await expect(store.turns.get("run:next")).resolves.toMatchObject({
      runId: "run:next",
    });
    await expect(store.turns.get("run:ghost")).resolves.toBeNull();
  });

  it.each([
    ["one store instance", false],
    ["two store instances", true],
  ])(
    "serves reads issued during transactions from a whole generation on %s",
    async (_caseName, separateInstances) => {
      // Given: committed records and handles on the same directory.
      const directory = await tempDir();
      const first = new FileExecutionStore(directory);
      const second = separateInstances
        ? new FileExecutionStore(directory)
        : first;
      await seedCommittedRecords(first);

      for (let index = 0; index < 6; index += 1) {
        const [writer, reader] =
          index % 2 === 0 ? [first, second] : [second, first];
        const runId = `run:extra-${index}`;
        const staged = createDeferred();
        const release = createDeferred();

        // When: reads start while a transaction is staged and about to
        // publish its generation and prune the one being read.
        const transaction = writer.transaction(async (tx) => {
          await tx.turns.create(runRecord(runId, { threadKey: THREAD_KEY }));
          await threadEventsOf(tx).append(THREAD_KEY, { type: "turn-start" });
          staged.resolve();
          await release.promise;
        });
        await staged.promise;
        const reads = Promise.all([
          reader.turns.get(runId),
          expectCommittedRecords(reader),
        ]);
        release.resolve();
        await transaction;

        // Then: the reads waited for the switch and saw the new generation.
        await expect(reads).resolves.toEqual([
          expect.objectContaining({ runId }),
          undefined,
        ]);
      }

      // Then: every commit landed and only the last generation remains.
      await expect(
        collectThreadEvents(first.threadEvents.read(THREAD_KEY))
      ).resolves.toHaveLength(7);
      await expect(readdir(join(directory, "generations"))).resolves.toEqual([
        basename(await currentDataDirectory(directory)),
      ]);
    }
  );
});

async function expectCommittedRecords(
  store: FileExecutionStore
): Promise<void> {
  const [run, checkpoint, thread, events, threadEvents, notification] =
    await Promise.all([
      store.turns.get(RUN_ID),
      store.checkpoints.latest(RUN_ID),
      store.threads.load(THREAD_KEY),
      collectEvents(store.events.read(RUN_ID)),
      collectThreadEvents(store.threadEvents.read(THREAD_KEY)),
      store.notifications.getByIdempotencyKey("notify:kept"),
    ]);
  expect(run).toMatchObject({ checkpointVersion: 1, runId: RUN_ID });
  expect(checkpoint).toEqual(checkpointRecord(RUN_ID, 1));
  expect(thread).toMatchObject({ state: { value: "kept" } });
  expect(events).toMatchObject([{ event: { type: "turn-start" } }]);
  expect(threadEvents.length).toBeGreaterThanOrEqual(1);
  expect(notification).toMatchObject({ idempotencyKey: "notify:kept" });
}

async function seedCommittedRecords(store: FileExecutionStore): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.turns.create(runRecord(RUN_ID, { threadKey: THREAD_KEY }));
    await tx.checkpoints.append(checkpointRecord(RUN_ID, 1), {
      expectedVersion: 0,
    });
    await tx.events.append(RUN_ID, { type: "turn-start" });
    await threadEventsOf(tx).append(THREAD_KEY, { type: "turn-start" });
    await tx.threads.commit(
      THREAD_KEY,
      { state: { value: "kept" } },
      { expectedVersion: null }
    );
    await tx.inputs.admit({
      admittedAtMs: 10,
      input: { text: "kept", type: "user-input" },
      kind: "send",
      messageId: "input:kept",
      threadKey: THREAD_KEY,
    });
    await tx.notifications.enqueue(
      notificationRecord("notify:kept", {
        runId: RUN_ID,
        threadKey: THREAD_KEY,
      })
    );
    await schedulerOf(tx).enqueueRun(RUN_ID);
  });
}

async function stagedGeneration(
  directory: string,
  committed: string
): Promise<string> {
  const staged = (await readdir(join(directory, "generations"))).find(
    (generation) => generation !== basename(committed)
  );
  if (!staged) {
    throw new Error("Expected a staged transaction generation.");
  }
  return join(directory, "generations", staged);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name);
      snapshot[relative(root, file)] = await readFile(file, "utf8");
    }
  }
  return snapshot;
}

function threadEventsOf(tx: HostStoreTransaction): ThreadEventLog {
  if (!tx.threadEvents) {
    throw new Error("Expected transactional thread events.");
  }
  return tx.threadEvents;
}

function schedulerOf(tx: HostStoreTransaction): HostScheduler {
  if (!tx.scheduler) {
    throw new Error("Expected a transactional scheduler.");
  }
  return tx.scheduler;
}
