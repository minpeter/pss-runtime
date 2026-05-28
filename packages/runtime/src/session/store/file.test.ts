import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionStore } from "./file";

const corruptJsonPattern = /invalid JSON/;
const sessionFileName = (key: string) =>
  `${Buffer.from(key).toString("base64url")}.json`;
const unsupportedFileShapePattern = /expected state and string version/;

function tempDir() {
  return mkdtemp(join(tmpdir(), "pss-runtime-file-store-"));
}

describe("FileSessionStore", () => {
  it("persists opaque state across store instances", async () => {
    const dir = await tempDir();
    const firstStore = new FileSessionStore(dir);

    await expect(
      firstStore.commit(
        "session:a",
        { state: { count: 1 } },
        { expectedVersion: null }
      )
    ).resolves.toEqual({
      ok: true,
      version: "1",
    });

    await expect(new FileSessionStore(dir).load("session:a")).resolves.toEqual({
      state: { count: 1 },
      version: "1",
    });
  });

  it("isolates distinct keys", async () => {
    const dir = await tempDir();
    const store = new FileSessionStore(dir);
    await store.commit("a", { state: { key: "a" } }, { expectedVersion: null });
    await store.commit("b", { state: { key: "b" } }, { expectedVersion: null });

    await expect(store.load("a")).resolves.toMatchObject({
      state: { key: "a" },
    });
    await expect(store.load("b")).resolves.toMatchObject({
      state: { key: "b" },
    });
  });

  it("detects expectedVersion conflicts", async () => {
    const dir = await tempDir();
    const store = new FileSessionStore(dir);
    await store.commit(
      "key",
      { state: { value: 1 } },
      { expectedVersion: null }
    );

    await expect(
      store.commit("key", { state: { value: 2 } }, { expectedVersion: "stale" })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("serializes expectedVersion checks across concurrent writers", async () => {
    const dir = await tempDir();
    const store = new FileSessionStore(dir);
    await expect(
      store.commit("key", { state: { value: 1 } }, { expectedVersion: null })
    ).resolves.toEqual({
      ok: true,
      version: "1",
    });

    const results = await Promise.all([
      store.commit("key", { state: { value: 2 } }, { expectedVersion: "1" }),
      store.commit("key", { state: { value: 3 } }, { expectedVersion: "1" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "conflict" },
    ]);
    const stored = await store.load("key");
    expect(stored?.version).toBe("2");
    expect([2, 3]).toContain((stored?.state as { value?: unknown })?.value);
  });

  it("serializes first-write expectedVersion checks", async () => {
    const dir = await tempDir();
    const store = new FileSessionStore(dir);

    const results = await Promise.all([
      store.commit("key", { state: { value: 1 } }, { expectedVersion: null }),
      store.commit("key", { state: { value: 2 } }, { expectedVersion: null }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "conflict" },
    ]);
  });

  it("clears stale lock directories before committing", async () => {
    const dir = await tempDir();
    const key = "stale";
    const lockDirectory = join(dir, `${sessionFileName(key)}.lock`);
    await mkdir(lockDirectory);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, staleTime, staleTime);

    await expect(
      new FileSessionStore(dir).commit(
        key,
        { state: { value: 1 } },
        { expectedVersion: null }
      )
    ).resolves.toEqual({ ok: true, version: "1" });
  });

  it("throws a deterministic error for corrupt JSON", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, sessionFileName("bad")), "{ nope", "utf8");

    await expect(new FileSessionStore(dir).load("bad")).rejects.toThrow(
      corruptJsonPattern
    );
  });

  it("throws a deterministic error for unsupported file shape", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, sessionFileName("bad")),
      JSON.stringify({ history: [] }),
      "utf8"
    );

    await expect(new FileSessionStore(dir).load("bad")).rejects.toThrow(
      unsupportedFileShapePattern
    );
  });
});
