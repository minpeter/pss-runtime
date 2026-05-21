import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "./memory";

describe("MemorySessionStore", () => {
  it("loads null for unknown sessions", async () => {
    await expect(new MemorySessionStore().load("missing")).resolves.toBeNull();
  });

  it("commits opaque state and increments versions", async () => {
    const store = new MemorySessionStore();

    const first = await store.commit("key", { state: { value: 1 } });
    expect(first).toEqual({ ok: true, version: "1" });
    await expect(store.load("key")).resolves.toEqual({
      state: { value: 1 },
      version: "1",
    });

    const second = await store.commit(
      "key",
      { state: { value: 2 } },
      { expectedVersion: "1" }
    );
    expect(second).toEqual({ ok: true, version: "2" });
  });

  it("detects expectedVersion conflicts", async () => {
    const store = new MemorySessionStore();
    await store.commit("key", { state: { value: 1 } });

    await expect(
      store.commit("key", { state: { value: 2 } }, { expectedVersion: "stale" })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("detects expectedVersion null conflicts for existing sessions", async () => {
    const store = new MemorySessionStore();
    await store.commit("key", { state: { value: 1 } });

    await expect(
      store.commit("key", { state: { value: 2 } }, { expectedVersion: null })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("protects committed state from caller mutation", async () => {
    const store = new MemorySessionStore();
    const state = { nested: { value: 1 } };
    await store.commit("key", { state });
    state.nested.value = 2;

    const loaded = await store.load("key");
    expect(loaded).toEqual({ state: { nested: { value: 1 } }, version: "1" });

    (loaded?.state as { nested: { value: number } }).nested.value = 3;
    await expect(store.load("key")).resolves.toEqual({
      state: { nested: { value: 1 } },
      version: "1",
    });
  });
});
