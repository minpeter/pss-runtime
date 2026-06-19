import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import type {
  NotificationRecord,
  RunCheckpoint,
  RunRecord,
  StoredAgentEvent,
} from "../../../execution";
import { FileExecutionStore } from "./file-execution-store";

const base64Url = (value: string) => Buffer.from(value).toString("base64url");
const malformedCheckpointPattern =
  /Invalid FileExecutionStore checkpoint file .*invalid JSON/;
const malformedEventPattern =
  /Invalid FileExecutionStore event log .*invalid JSON/;
const malformedNotificationPattern =
  /Invalid FileExecutionStore notification file .*invalid JSON/;
const malformedRunPattern =
  /Invalid FileExecutionStore run file .*invalid JSON/;
const malformedThreadPattern = /Invalid FileThreadStore file .*invalid JSON/;

describeExecutionStoreContract({
  createStore: () => new FileExecutionStore(join(tmpdir(), randomUUID())),
  name: "FileExecutionStore",
});

describe("FileExecutionStore", () => {
  it("persists execution ports in separate files across store instances", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    const run = runRecord("run:persist", {
      dedupeKey: "dedupe:persist",
      parentRunId: "parent:persist",
    });
    const checkpoint = checkpointRecord("run:persist", 1);
    const notification = notificationRecord("notify:persist", {
      runId: "run:persist",
    });

    await expect(store.runs.create(run)).resolves.toEqual({
      ok: true,
      record: run,
    });
    await expect(
      store.events.append("run:persist", { type: "turn-start" })
    ).resolves.toEqual({ offset: 1 });
    await expect(
      store.checkpoints.append(checkpoint, { expectedVersion: 0 })
    ).resolves.toEqual({
      ok: true,
      version: 1,
    });
    await expect(store.notifications.enqueue(notification)).resolves.toEqual({
      ok: true,
    });
    await expect(
      store.threads.commit(
        "thread:persist",
        { state: { messages: ["persisted"] } },
        { expectedVersion: null }
      )
    ).resolves.toEqual({ ok: true, version: "1" });

    const reopened = new FileExecutionStore(directory);
    await expect(reopened.runs.get("run:persist")).resolves.toEqual({
      ...run,
      checkpointVersion: 1,
    });
    await expect(
      reopened.runs.getByDedupeKey("dedupe:persist")
    ).resolves.toEqual({
      ...run,
      checkpointVersion: 1,
    });
    await expect(
      reopened.runs.listByParentRunId("parent:persist")
    ).resolves.toEqual([{ ...run, checkpointVersion: 1 }]);
    await expect(reopened.checkpoints.latest("run:persist")).resolves.toEqual(
      checkpoint
    );
    await expect(
      collectEvents(reopened.events.read("run:persist"))
    ).resolves.toEqual([
      {
        cursor: { offset: 1 },
        event: { type: "turn-start" },
        runId: "run:persist",
      },
    ]);
    await expect(
      reopened.notifications.getByIdempotencyKey("notify:persist")
    ).resolves.toEqual(notification);
    await expect(reopened.threads.load("thread:persist")).resolves.toEqual({
      state: { messages: ["persisted"] },
      version: "1",
    });
    expect(reopened.sessions).toBe(reopened.threads);

    const dataDirectory = await currentDataDirectory(directory);

    await expect(readdir(join(dataDirectory, "threads"))).resolves.toContain(
      `${base64Url("thread:persist")}.json`
    );
    await expect(readdir(join(dataDirectory, "runs"))).resolves.toContain(
      `${base64Url("run:persist")}.json`
    );
    await expect(readdir(join(dataDirectory, "events"))).resolves.toContain(
      `${base64Url("run:persist")}.jsonl`
    );
    await expect(
      readdir(join(dataDirectory, "checkpoints", base64Url("run:persist")))
    ).resolves.toEqual(["1.json"]);
    await expect(
      readdir(join(dataDirectory, "notifications"))
    ).resolves.toContain(`${base64Url("notify:persist")}.json`);
  });

  it("returns the existing run for duplicate run ids and dedupe keys", async () => {
    const store = new FileExecutionStore(await tempDir());
    const original = runRecord("run:duplicate", {
      dedupeKey: "dedupe:duplicate",
    });

    await expect(store.runs.create(original)).resolves.toEqual({
      ok: true,
      record: original,
    });
    await expect(
      store.runs.create({
        ...runRecord("run:duplicate"),
        checkpointVersion: 7,
        dedupeKey: "other-dedupe",
        status: "completed",
      })
    ).resolves.toEqual({
      ok: false,
      reason: "duplicate",
      record: original,
    });
    await expect(
      store.runs.create({
        ...runRecord("run:other"),
        dedupeKey: "dedupe:duplicate",
      })
    ).resolves.toEqual({
      ok: false,
      reason: "duplicate",
      record: original,
    });
    await expect(store.runs.get("run:duplicate")).resolves.toEqual(original);
    await expect(store.runs.get("run:other")).resolves.toBeNull();
  });

  it("claims only claimable runs after active leases expire", async () => {
    const store = new FileExecutionStore(await tempDir());
    await store.runs.create(runRecord("run:claim"));

    await expect(
      store.runs.claim("run:claim", {
        attempt: 1,
        leaseId: "lease-1",
        leaseMs: 100,
        nowMs: 1000,
      })
    ).resolves.toMatchObject({
      lease: { attempt: 1, leaseId: "lease-1", leaseUntilMs: 1100 },
      ok: true,
      record: { status: "leased" },
    });
    await expect(
      store.runs.claim("run:claim", {
        attempt: 2,
        leaseId: "lease-2",
        leaseMs: 100,
        nowMs: 1099,
      })
    ).resolves.toEqual({ ok: false, reason: "leased" });
    await expect(
      store.runs.claim("run:claim", {
        attempt: 2,
        leaseId: "lease-2",
        leaseMs: 50,
        nowMs: 1100,
      })
    ).resolves.toMatchObject({
      lease: { attempt: 2, leaseId: "lease-2", leaseUntilMs: 1150 },
      ok: true,
    });

    await store.runs.create(runRecord("run:done", { status: "completed" }));
    await expect(
      store.runs.claim("run:done", {
        attempt: 1,
        leaseId: "lease-done",
        leaseMs: 100,
        nowMs: 0,
      })
    ).resolves.toEqual({ ok: false, reason: "not-claimable" });
  });

  it("acks and releases notifications by idempotency key", async () => {
    const store = new FileExecutionStore(await tempDir());
    const notification = notificationRecord("notify:claim");

    await expect(store.notifications.enqueue(notification)).resolves.toEqual({
      ok: true,
    });
    await expect(
      store.notifications.claimByIdempotencyKey("notify:claim")
    ).resolves.toEqual({
      ok: true,
      record: { ...notification, status: "acked" },
    });
    await expect(
      store.notifications.getByIdempotencyKey("notify:claim")
    ).resolves.toEqual({ ...notification, status: "acked" });
    await expect(
      store.notifications.claimByIdempotencyKey("notify:claim")
    ).resolves.toEqual({
      ok: false,
      reason: "already-claimed",
      record: { ...notification, status: "acked" },
    });

    await store.notifications.releaseByIdempotencyKey("notify:claim");

    await expect(
      store.notifications.getByIdempotencyKey("notify:claim")
    ).resolves.toEqual(notification);
  });

  it("rolls back file-backed transaction writes after a failure", async () => {
    const store = new FileExecutionStore(await tempDir());

    await expect(
      store.transaction(async (tx) => {
        await tx.runs.create(runRecord("run:rollback"));
        await tx.events.append("run:rollback", { type: "turn-start" });
        await tx.checkpoints.append(checkpointRecord("run:rollback", 1), {
          expectedVersion: 0,
        });
        await tx.notifications.enqueue(
          notificationRecord("notify:rollback", { runId: "run:rollback" })
        );
        await tx.threads.commit(
          "thread:rollback",
          { state: { value: "rollback" } },
          { expectedVersion: null }
        );
        throw new Error("rollback me");
      })
    ).rejects.toThrow("rollback me");

    await expect(store.runs.get("run:rollback")).resolves.toBeNull();
    await expect(
      collectEvents(store.events.read("run:rollback"))
    ).resolves.toEqual([]);
    await expect(store.checkpoints.latest("run:rollback")).resolves.toBeNull();
    await expect(
      store.notifications.getByIdempotencyKey("notify:rollback")
    ).resolves.toBeNull();
    await expect(store.threads.load("thread:rollback")).resolves.toBeNull();
  });

  it("serializes direct thread writes against transaction directory swaps", async () => {
    const store = new FileExecutionStore(await tempDir());
    const transactionStarted = createDeferred();
    const transactionCanFinish = createDeferred();
    let outsideSettled = false;

    const transaction = store.transaction(async (tx) => {
      await tx.threads.commit(
        "thread:inside",
        { state: { value: "inside" } },
        { expectedVersion: null }
      );
      transactionStarted.resolve();
      await transactionCanFinish.promise;
    });

    await transactionStarted.promise;

    const outside = store.threads
      .commit(
        "thread:outside",
        { state: { value: "outside" } },
        { expectedVersion: null }
      )
      .then(() => {
        outsideSettled = true;
      });

    await Promise.resolve();
    expect(outsideSettled).toBe(false);

    transactionCanFinish.resolve();
    await transaction;
    await outside;

    await expect(store.threads.load("thread:inside")).resolves.toMatchObject({
      state: { value: "inside" },
    });
    await expect(store.threads.load("thread:outside")).resolves.toMatchObject({
      state: { value: "outside" },
    });
  });

  it("keeps long transaction locks fresh while direct thread writes wait", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    const transactionStarted = createDeferred();
    const transactionCanFinish = createDeferred();
    let outsideSettled = false;

    const transaction = store.transaction(async (tx) => {
      await tx.threads.commit(
        "thread:inside",
        { state: { value: "inside" } },
        { expectedVersion: null }
      );
      transactionStarted.resolve();
      await transactionCanFinish.promise;
    });

    await transactionStarted.promise;
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(join(directory, ".execution.lock"), staleTime, staleTime);
    await setTimeout(150);

    const outside = store.threads
      .commit(
        "thread:outside",
        { state: { value: "outside" } },
        { expectedVersion: null }
      )
      .then(() => {
        outsideSettled = true;
      });

    await setTimeout(20);
    expect(outsideSettled).toBe(false);

    transactionCanFinish.resolve();
    await transaction;
    await outside;

    await expect(store.threads.load("thread:inside")).resolves.toMatchObject({
      state: { value: "inside" },
    });
    await expect(store.threads.load("thread:outside")).resolves.toMatchObject({
      state: { value: "outside" },
    });
  });

  it("throws deterministic errors for malformed persisted JSON files", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await expect(store.runs.get("run:missing")).resolves.toBeNull();
    const dataDirectory = await currentDataDirectory(directory);

    await mkdir(join(dataDirectory, "runs"), { recursive: true });
    await mkdir(join(dataDirectory, "events"), { recursive: true });
    await mkdir(join(dataDirectory, "checkpoints", base64Url("run:bad")), {
      recursive: true,
    });
    await mkdir(join(dataDirectory, "notifications"), { recursive: true });
    await mkdir(join(dataDirectory, "threads"), { recursive: true });
    await writeFile(
      join(dataDirectory, "runs", `${base64Url("run:bad")}.json`),
      "{ nope",
      "utf8"
    );
    await writeFile(
      join(dataDirectory, "events", `${base64Url("run:bad")}.jsonl`),
      "{ nope\n",
      "utf8"
    );
    await writeFile(
      join(dataDirectory, "checkpoints", base64Url("run:bad"), "1.json"),
      "{ nope",
      "utf8"
    );
    await writeFile(
      join(dataDirectory, "notifications", `${base64Url("notify:bad")}.json`),
      "{ nope",
      "utf8"
    );
    await writeFile(
      join(dataDirectory, "threads", `${base64Url("thread:bad")}.json`),
      "{ nope",
      "utf8"
    );

    await expect(store.runs.get("run:bad")).rejects.toThrow(
      malformedRunPattern
    );
    await expect(collectEvents(store.events.read("run:bad"))).rejects.toThrow(
      malformedEventPattern
    );
    await expect(store.checkpoints.latest("run:bad")).rejects.toThrow(
      malformedCheckpointPattern
    );
    await expect(
      store.notifications.getByIdempotencyKey("notify:bad")
    ).rejects.toThrow(malformedNotificationPattern);
    await expect(store.threads.load("thread:bad")).rejects.toThrow(
      malformedThreadPattern
    );
  });
});

async function collectEvents(
  events: AsyncIterable<StoredAgentEvent>
): Promise<readonly StoredAgentEvent[]> {
  const collected: StoredAgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pss-runtime-file-execution-store-"));
}

async function currentDataDirectory(directory: string): Promise<string> {
  const generationId = await readFile(
    join(directory, ".current-generation"),
    "utf8"
  );
  return join(directory, "generations", generationId.trim());
}

function createDeferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

function runRecord(
  runId: string,
  overrides: Partial<RunRecord> = {}
): RunRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey: "thread-1",
    status: "queued",
    ...overrides,
  };
}

function checkpointRecord(runId: string, version: number): RunCheckpoint {
  return {
    checkpointId: `${runId}:checkpoint-${version}`,
    phase: "before-model",
    runId,
    runtimeState: { version },
    threadSnapshot: { version },
    version,
  };
}

function notificationRecord(
  idempotencyKey: string,
  overrides: Partial<NotificationRecord> = {}
): NotificationRecord {
  return {
    idempotencyKey,
    input: { text: "ready", type: "user-text" },
    notificationId: `${idempotencyKey}:notification`,
    runId: "run-1",
    threadKey: "thread-1",
    status: "pending",
    ...overrides,
  };
}
