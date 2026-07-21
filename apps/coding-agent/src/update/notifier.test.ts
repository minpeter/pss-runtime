import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readUpdateCheckCache,
  UPDATE_CHECK_TTL_MS,
  writeUpdateCheckCache,
} from "./check";
import { emitUpdateNotice, isUpdateCheckDisabled } from "./notifier";

describe("isUpdateCheckDisabled", () => {
  it("is disabled by explicit opt-out values", () => {
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "1" })).toBe(true);
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "true" })).toBe(
      true
    );
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "TRUE" })).toBe(
      true
    );
  });

  it("stays enabled for unset or other values", () => {
    expect(isUpdateCheckDisabled({})).toBe(false);
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "0" })).toBe(
      false
    );
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "yes" })).toBe(
      false
    );
  });
});

describe("emitUpdateNotice", () => {
  const withTempCache =
    (
      run: (context: {
        cachePath: string;
        lines: string[];
        tasks: (() => Promise<void>)[];
      }) => Promise<void>
    ) =>
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "pss-update-notifier-"));
      const lines: string[] = [];
      const tasks: (() => Promise<void>)[] = [];
      try {
        await run({
          cachePath: join(directory, "update-check.json"),
          lines,
          tasks,
        });
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    };

  it(
    "stays silent for a dev build without a baked version",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: undefined,
        cachePath,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toEqual([]);
      expect(tasks).toEqual([]);
    })
  );

  it(
    "stays silent when the kill switch is set",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      await writeUpdateCheckCache(cachePath, {
        checkedAt: new Date().toISOString(),
        tags: { latest: "99.0.0" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: { PSS_DISABLE_UPDATE_CHECK: "1" },
        version: "0.0.13",
        cachePath,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toEqual([]);
      expect(tasks).toEqual([]);
    })
  );

  it(
    "writes the cached notice and skips the refresh when the cache is fresh",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        fetchTags: () => Promise.reject(new Error("must not fetch")),
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("0.0.13");
      expect(lines[0]).toContain("0.0.14");
      expect(tasks).toEqual([]);
    })
  );

  it(
    "writes nothing when the cached version is current",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.13" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toEqual([]);
      expect(tasks).toEqual([]);
    })
  );

  it(
    "writes the cached notice and refreshes a stale cache for the next run",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-22T12:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: new Date(now - UPDATE_CHECK_TTL_MS - 1).toISOString(),
        tags: { latest: "0.0.14" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        fetchTags: () => Promise.resolve({ latest: "0.0.15" }),
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("0.0.14");
      expect(tasks).toHaveLength(1);

      const [refresh] = tasks;
      await refresh?.();

      const cache = await readUpdateCheckCache(cachePath);
      expect(cache?.tags).toEqual({ latest: "0.0.15" });
      expect(cache?.checkedAt).toBe(new Date(now).toISOString());
    })
  );

  it(
    "schedules a refresh that populates a missing cache without writing a line",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        fetchTags: () => Promise.resolve({ latest: "0.0.14" }),
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toEqual([]);
      expect(tasks).toHaveLength(1);

      const [refresh] = tasks;
      await refresh?.();

      expect(await readUpdateCheckCache(cachePath)).toEqual({
        checkedAt: new Date(now).toISOString(),
        tags: { latest: "0.0.14" },
      });
    })
  );

  it(
    "resolves without rejecting when the notice writer throws",
    withTempCache(async ({ cachePath, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14" },
      });

      await emitUpdateNotice({
        write: () => {
          throw new Error("render pipeline broken");
        },
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(tasks).toEqual([]);
    })
  );

  it(
    "resolves the scheduled refresh when the tag fetch throws",
    withTempCache(async ({ cachePath, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");

      await emitUpdateNotice({
        write: () => undefined,
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        fetchTags: () => Promise.reject(new Error("registry unreachable")),
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(tasks).toHaveLength(1);
      const [refresh] = tasks;
      await expect(refresh?.()).resolves.toBeUndefined();
    })
  );

  it(
    "persists nothing when a refresh yields no channels",
    withTempCache(async ({ cachePath, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");

      await emitUpdateNotice({
        write: () => undefined,
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        fetchTags: () => Promise.resolve({}),
        schedule: (task) => {
          tasks.push(task);
        },
      });

      const [refresh] = tasks;
      await refresh?.();

      expect(await readUpdateCheckCache(cachePath)).toBeUndefined();
    })
  );

  it(
    "keeps the existing cache when a refresh yields no channels",
    withTempCache(async ({ cachePath, tasks }) => {
      const now = Date.parse("2026-07-22T12:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: new Date(now - UPDATE_CHECK_TTL_MS - 1).toISOString(),
        tags: { next: "9.9.9-next.9" },
      });

      await emitUpdateNotice({
        write: () => undefined,
        env: {},
        version: "0.0.14-next.2",
        cachePath,
        now: () => now,
        fetchTags: () => Promise.resolve({}),
        schedule: (task) => {
          tasks.push(task);
        },
      });

      const [refresh] = tasks;
      await refresh?.();

      expect(await readUpdateCheckCache(cachePath)).toEqual({
        checkedAt: new Date(now - UPDATE_CHECK_TTL_MS - 1).toISOString(),
        tags: { next: "9.9.9-next.9" },
      });
    })
  );

  it(
    "announces a stable release that surpasses a next-channel install",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14", next: "0.0.14-next.2" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.14-next.2",
        cachePath,
        now: () => now,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("0.0.14");
      expect(lines[0]).toContain("--channel latest");
      expect(tasks).toEqual([]);
    })
  );
});
