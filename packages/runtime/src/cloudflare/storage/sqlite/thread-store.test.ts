import { describe, expect, it } from "vitest";
import { decodeStoredThreadSnapshot } from "../../../thread/state/snapshot";
import type { CloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectSqliteThreadStore } from "./thread-store";
import {
  createStore,
  PREFIX,
  readChunkRows,
  REQUIRES_SQLITE,
  readRows,
  snapshot,
} from "./thread-store.test-support";

describe("DurableObjectSqliteThreadStore", () => {
  it("throws when the Durable Object is not SQLite-backed", () => {
    expect(
      () =>
        new DurableObjectSqliteThreadStore(
          {} as CloudflareDurableObjectStorage,
          PREFIX
        )
    ).toThrow(REQUIRES_SQLITE);
  });

  it("loads null for unknown threads", async () => {
    const { store } = createStore();
    await expect(store.load("missing")).resolves.toBeNull();
  });

  it("commits a v1 snapshot and increments versions", async () => {
    const { store } = createStore();

    const first = await store.commit(
      "key",
      snapshot([{ content: "hi", role: "user" }]),
      { expectedVersion: null }
    );
    expect(first).toEqual({ ok: true, version: "1" });
    await expect(store.load("key")).resolves.toEqual({
      state: { history: [{ content: "hi", role: "user" }], schemaVersion: 1 },
      version: "1",
    });

    const second = await store.commit(
      "key",
      snapshot([
        { content: "hi", role: "user" },
        { content: "yo", role: "assistant" },
      ]),
      { expectedVersion: "1" }
    );
    expect(second).toEqual({ ok: true, version: "2" });
  });

  it("appends only the new messages (delta-append, unchanged prefix kept)", async () => {
    const { storage, store } = createStore();
    await store.commit("k", snapshot([{ i: 0 }, { i: 1 }]), {
      expectedVersion: null,
    });
    await store.commit(
      "k",
      snapshot([{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]),
      { expectedVersion: "1" }
    );

    const rows = readRows(storage, "k");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.active === 1)).toBe(true);
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3]);
    expect(rows[0].message).toBe(JSON.stringify({ i: 0 }));
    expect(rows[1].message).toBe(JSON.stringify({ i: 1 }));
  });

  it("soft-deletes the trailing rows on rollback (history shrank)", async () => {
    const { storage, store } = createStore();
    await store.commit(
      "k",
      snapshot([{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]),
      {
        expectedVersion: null,
      }
    );
    await store.commit("k", snapshot([{ i: 0 }, { i: 1 }]), {
      expectedVersion: "1",
    });

    await expect(store.load("k")).resolves.toEqual({
      state: { history: [{ i: 0 }, { i: 1 }], schemaVersion: 1 },
      version: "2",
    });
    const rows = readRows(storage, "k");
    expect(
      rows.filter((row) => row.active === 1).map((row) => row.seq)
    ).toEqual([0, 1]);
    expect(
      rows.filter((row) => row.active === 0).map((row) => row.seq)
    ).toEqual([2, 3]);
  });

  it("regrows with divergent content without reusing soft-deleted seqs", async () => {
    const { storage, store } = createStore();
    await store.commit("k", snapshot([{ i: 0 }, { i: 1 }, { i: 2 }]), {
      expectedVersion: null,
    });
    // Rollback to 1 message.
    await store.commit("k", snapshot([{ i: 0 }]), { expectedVersion: "1" });
    // Regrow with new, different content at index 1.
    await store.commit("k", snapshot([{ i: 0 }, { x: 9 }]), {
      expectedVersion: "2",
    });

    await expect(store.load("k")).resolves.toEqual({
      state: { history: [{ i: 0 }, { x: 9 }], schemaVersion: 1 },
      version: "3",
    });
    const activeSeqs = readRows(storage, "k")
      .filter((row) => row.active === 1)
      .map((row) => row.seq);
    // seq 1 was soft-deleted; the new message must take a fresh seq (3), not reuse 1.
    expect(activeSeqs).toEqual([0, 3]);
  });

  it("does not persist extra runtime payload fields", async () => {
    const { store } = createStore();
    await store.commit(
      "key",
      {
        ignored: true,
        state: { value: 1 },
        version: "caller",
      } as never,
      { expectedVersion: null }
    );

    await expect(store.load("key")).resolves.toEqual({
      state: { value: 1 },
      version: "1",
    });
  });

  it("detects stale expectedVersion conflicts", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });

    await expect(
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: "stale" })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("detects expectedVersion null conflicts for existing threads", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });

    await expect(
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: null })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("chunks snapshot message rows that exceed the serialized payload budget", async () => {
    const { storage, store } = createStore({ maxPayloadBytes: 80 });
    const bigMessage = { content: "x".repeat(120), role: "user" };

    await expect(
      store.commit("key", snapshot([bigMessage]), { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });

    const [row] = readRows(storage, "key");
    expect(row?.message).toBe(JSON.stringify({ $pss: "chunk", n: 2 }));
    expect(readChunkRows(storage, "key")).toHaveLength(2);
    await expect(store.load("key")).resolves.toEqual({
      state: { history: [bigMessage], schemaVersion: 1 },
      version: "1",
    });
  });

  it("rejects opaque thread state blobs that exceed the serialized payload budget", async () => {
    const { store } = createStore({ maxPayloadBytes: 80 });

    await expect(
      store.commit(
        "opaque",
        { state: { notes: "x".repeat(120) } },
        { expectedVersion: null }
      )
    ).rejects.toMatchObject({
      maxBytes: 80,
      payloadKind: "thread-state",
    });
    await expect(store.load("opaque")).resolves.toBeNull();
  });

  it("deletes thread state and resets the version counter", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });

    await store.delete("key");

    await expect(store.load("key")).resolves.toBeNull();
    await expect(
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });
  });

  it("protects committed state from caller mutation", async () => {
    const { store } = createStore();
    const history = [{ nested: { value: 1 } }];
    await store.commit("key", snapshot(history), { expectedVersion: null });
    (history[0].nested as { value: number }).value = 2;

    const loaded = await store.load("key");
    expect(loaded).toEqual({
      state: { history: [{ nested: { value: 1 } }], schemaVersion: 1 },
      version: "1",
    });

    const loadedHistory = (
      loaded?.state as { history: { nested: { value: number } }[] }
    ).history;
    loadedHistory[0].nested.value = 3;
    await expect(store.load("key")).resolves.toEqual({
      state: { history: [{ nested: { value: 1 } }], schemaVersion: 1 },
      version: "1",
    });
  });

  it("serializes expectedVersion checks across concurrent writers", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });

    const results = await Promise.all([
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: "1" }),
      store.commit("key", snapshot([{ i: 2 }]), { expectedVersion: "1" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "conflict" },
    ]);
    await expect(store.load("key")).resolves.toMatchObject({ version: "2" });
  });

  it("serializes first-write expectedVersion checks", async () => {
    const { store } = createStore();

    const results = await Promise.all([
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: null }),
      store.commit("key", snapshot([{ i: 2 }]), { expectedVersion: null }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "conflict" },
    ]);
  });

  it("round-trips a thread whose total size exceeds the 2MB blob limit", async () => {
    const { store } = createStore();
    const big = "x".repeat(60_000);
    const history = Array.from({ length: 50 }, (_, index) => ({
      content: `${index}:${big}`,
      role: "assistant",
    }));

    await expect(
      store.commit("big", snapshot(history), { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });

    const loaded = await store.load("big");
    expect((loaded?.state as { history: unknown[] }).history).toHaveLength(50);
  });

  it("load output decodes via decodeStoredThreadSnapshot", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ content: "hi", role: "user" }]), {
      expectedVersion: null,
    });
    const loaded = await store.load("key");
    expect(decodeStoredThreadSnapshot(loaded)).toEqual([
      { content: "hi", role: "user" },
    ]);
  });

  it("treats a deleted and re-created thread as a brand-new thread", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });
    await store.delete("key");
    await expect(
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });
  });
});
