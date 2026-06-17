import { describe, expect, it } from "vitest";
import type { RunRecord } from "../execution";
import { DurableObjectRunStore } from "./cloudflare-run-store";
import {
  type DurableObjectSqliteCheckpointStore as CheckpointStoreType,
  DurableObjectSqliteCheckpointStore,
} from "./cloudflare-sqlite-checkpoint-store";
import { storeKey } from "./cloudflare-store-utils";
import { InMemoryCloudflareDurableObjectStorage } from "./durable-object-storage";
import { InMemorySqlStorage } from "./in-memory-sql-storage";

const PREFIX = "pss-runtime";
const REQUIRES_SQLITE = /SQLite-backed/;

interface CheckpointRowProbe {
  readonly checkpoint: string;
  readonly version: number;
}

function checkpoint(
  runId: string,
  version: number,
  overrides: Partial<{
    checkpointId: string;
    phase: "before-model" | "after-tool";
    runtimeState: unknown;
    sessionSnapshot: unknown;
  }> = {}
): Parameters<CheckpointStoreType["append"]>[0] {
  return {
    checkpointId: overrides.checkpointId ?? `checkpoint-${version}`,
    phase: overrides.phase ?? "before-model",
    runId,
    runtimeState: overrides.runtimeState ?? {},
    sessionSnapshot: overrides.sessionSnapshot ?? {},
    version,
  };
}

function createRun(runId = "run-1"): RunRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    sessionKey: "session-1",
    status: "queued",
  };
}

async function createRanStore(runId = "run-1"): Promise<{
  readonly storage: InMemoryCloudflareDurableObjectStorage;
  readonly store: DurableObjectSqliteCheckpointStore;
}> {
  const storage = new InMemoryCloudflareDurableObjectStorage({
    sql: new InMemorySqlStorage(),
  });
  const runs = new DurableObjectRunStore(storage, PREFIX);
  await runs.create(createRun(runId));
  const store = new DurableObjectSqliteCheckpointStore(storage, PREFIX);
  return { storage, store };
}

function readRows(
  storage: InMemoryCloudflareDurableObjectStorage,
  runId: string
): CheckpointRowProbe[] {
  return (storage.sql as InMemorySqlStorage)
    .exec<CheckpointRowProbe>(
      "SELECT version, checkpoint FROM pss_checkpoint WHERE run_key = ? ORDER BY version",
      storeKey(PREFIX, "checkpoints", runId)
    )
    .toArray();
}

describe("DurableObjectSqliteCheckpointStore", () => {
  it("throws when the Durable Object is not SQLite-backed", () => {
    expect(
      () =>
        new DurableObjectSqliteCheckpointStore(
          new InMemoryCloudflareDurableObjectStorage(),
          PREFIX
        )
    ).toThrow(REQUIRES_SQLITE);
  });

  it("appends a checkpoint as one row and returns the version", async () => {
    const { store, storage } = await createRanStore();

    const result = await store.append(checkpoint("run-1", 1), {
      expectedVersion: 0,
    });

    expect(result).toEqual({ ok: true, version: 1 });
    const rows = readRows(storage, "run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].checkpoint).toBe(JSON.stringify(checkpoint("run-1", 1)));
  });

  it("returns the latest checkpoint by version", async () => {
    const { store } = await createRanStore();
    await store.append(checkpoint("run-1", 1), { expectedVersion: 0 });
    await store.append(checkpoint("run-1", 2), { expectedVersion: 1 });
    await store.append(checkpoint("run-1", 3), { expectedVersion: 2 });

    await expect(store.latest("run-1")).resolves.toMatchObject({
      checkpointId: "checkpoint-3",
      version: 3,
    });
  });

  it("returns null for the latest checkpoint of an unknown run", async () => {
    const { store } = await createRanStore();
    await expect(store.latest("missing")).resolves.toBeNull();
  });

  it("rejects stale-version writes", async () => {
    const { store, storage } = await createRanStore();

    const first = await store.append(checkpoint("run-1", 1), {
      expectedVersion: 0,
    });
    const stale = await store.append(checkpoint("run-1", 2), {
      expectedVersion: 0,
    });

    expect(first).toEqual({ ok: true, version: 1 });
    expect(stale).toEqual({
      currentVersion: 1,
      ok: false,
      reason: "stale-version",
    });
    // Nothing was written for the rejected append: only the first checkpoint row exists.
    expect(readRows(storage, "run-1")).toHaveLength(1);
  });

  it("appends many checkpoints without losing earlier ones", async () => {
    const { store, storage } = await createRanStore();
    for (let version = 1; version <= 5; version += 1) {
      await store.append(checkpoint("run-1", version), {
        expectedVersion: version - 1,
      });
    }

    const rows = readRows(storage, "run-1");
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    await expect(store.latest("run-1")).resolves.toMatchObject({ version: 5 });
  });

  it("isolates checkpoints by run id", async () => {
    const { store } = await createRanStore("run-1");
    const { storage } = await (async () => {
      const storage = new InMemoryCloudflareDurableObjectStorage({
        sql: new InMemorySqlStorage(),
      });
      await new DurableObjectRunStore(storage, PREFIX).create(
        createRun("run-2")
      );
      return { storage };
    })();
    const secondStore = new DurableObjectSqliteCheckpointStore(storage, PREFIX);

    await store.append(checkpoint("run-1", 1), { expectedVersion: 0 });
    await secondStore.append(checkpoint("run-2", 1), { expectedVersion: 0 });

    await expect(store.latest("run-1")).resolves.toMatchObject({ version: 1 });
    expect(readRows(storage, "run-1")).toEqual([]);
    expect(readRows(storage, "run-2")).toHaveLength(1);
  });

  it("round-trips checkpoints whose snapshot payload exceeds the 2MB blob limit", async () => {
    // Reproduces the SQLITE_TOOBIG failure the legacy single-value KV store hit:
    // each checkpoint embeds a full session snapshot, and many tool-call
    // checkpoints past the ~2.2MB threshold blew up a single re-written value.
    const { store } = await createRanStore();
    const big = "x".repeat(120_000);

    for (let version = 1; version <= 20; version += 1) {
      await store.append(
        checkpoint("run-1", version, {
          sessionSnapshot: { history: [big] },
        }),
        { expectedVersion: version - 1 }
      );
    }

    const latest = await store.latest("run-1");
    expect(latest).toMatchObject({ version: 20 });
    expect(
      (latest?.sessionSnapshot as { history: string[] }).history[0]
    ).toHaveLength(120_000);
  });

  it("preserves full checkpoint fidelity (runtime state, phase, id)", async () => {
    const { store } = await createRanStore();
    const full = checkpoint("run-1", 1, {
      checkpointId: "cp-abc",
      phase: "after-tool",
      runtimeState: { toolCallId: "call_1", toolName: "web_search" },
      sessionSnapshot: { history: [{ role: "user", content: "hi" }] },
    });

    await store.append(full, { expectedVersion: 0 });

    await expect(store.latest("run-1")).resolves.toEqual(full);
  });
});
