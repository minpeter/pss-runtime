import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_PACKAGE_NAME,
  DEFAULT_REGISTRY_BASE_URL,
  decideUpdateNotice,
  fetchDistTags,
  formatUpdateNotice,
  isCacheFresh,
  parseUpdateCheckCache,
  publishedTagVersion,
  readUpdateCheckCache,
  resolveUpdateRegistryBaseUrl,
  UPDATE_CHECK_TTL_MS,
  writeUpdateCheckCache,
} from "./check";

describe("update check cache", () => {
  it("round-trips a cache file written atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "update-check.json");
      const cache = {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14", next: "0.0.14-next.3" },
      };

      await writeUpdateCheckCache(cachePath, cache);

      expect(await readUpdateCheckCache(cachePath)).toEqual(cache);
      expect(await readdir(directory)).toEqual(["update-check.json"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates the cache directory when missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "nested", "update-check.json");

      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: {},
      });

      expect(await readUpdateCheckCache(cachePath)).toEqual({
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: {},
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("treats a missing cache file as absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      expect(
        await readUpdateCheckCache(join(directory, "update-check.json"))
      ).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("round-trips arbitrary channel tags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "update-check.json");
      const cache = {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { canary: "0.0.16-canary.2", beta: "1.0.0-beta.3" },
      };

      await writeUpdateCheckCache(cachePath, cache);

      expect(await readUpdateCheckCache(cachePath)).toEqual(cache);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("parses a serialized cache document", () => {
    const parsed = parseUpdateCheckCache(
      JSON.stringify({
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14" },
      })
    );

    expect(parsed).toEqual({
      checkedAt: "2026-07-21T00:00:00.000Z",
      tags: { latest: "0.0.14" },
    });
  });

  it("rejects malformed cache documents", () => {
    expect(parseUpdateCheckCache("not json")).toBeUndefined();
    expect(parseUpdateCheckCache("{}")).toBeUndefined();
    expect(
      parseUpdateCheckCache('{"checkedAt":123,"tags":{}}')
    ).toBeUndefined();
    expect(
      parseUpdateCheckCache(
        '{"checkedAt":"2026-07-21T00:00:00.000Z","tags":{"latest":5}}'
      )
    ).toBeUndefined();
  });

  it("reads a corrupted cache file as absent instead of throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "update-check.json");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: {},
      });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(cachePath, "{corrupted");

      expect(await readUpdateCheckCache(cachePath)).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("isCacheFresh", () => {
  const cache = {
    checkedAt: "2026-07-21T00:00:00.000Z",
    tags: {},
  };

  it("is fresh within the TTL and stale past it", () => {
    const checkedAtMs = Date.parse(cache.checkedAt);

    expect(isCacheFresh(cache, checkedAtMs + UPDATE_CHECK_TTL_MS - 1)).toBe(
      true
    );
    expect(isCacheFresh(cache, checkedAtMs + UPDATE_CHECK_TTL_MS + 1)).toBe(
      false
    );
  });

  it("treats a future-dated cache as stale so it gets refreshed", () => {
    const now = Date.parse("2026-07-21T00:00:00.000Z");
    const future = {
      checkedAt: "2026-07-22T00:00:00.000Z",
      tags: {},
    };

    expect(isCacheFresh(future, now)).toBe(false);
  });
});

describe("decideUpdateNotice", () => {
  it("notifies a stable user when a newer stable version exists", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.13", channel: "latest" },
      { latest: "0.0.14", next: "0.0.15-next.0" }
    );

    expect(notice).toEqual({
      kind: "channel-update",
      channel: "latest",
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
    });
  });

  it("never offers a stable user a prerelease", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.13", channel: "latest" },
      { latest: "0.0.13", next: "0.0.14-next.2" }
    );

    expect(notice).toBeUndefined();
  });

  it("notifies a next user when a newer next version exists", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.14-next.1", channel: "next" },
      { latest: "0.0.13", next: "0.0.14-next.2" }
    );

    expect(notice).toEqual({
      kind: "channel-update",
      channel: "next",
      currentVersion: "0.0.14-next.1",
      latestVersion: "0.0.14-next.2",
    });
  });

  it("offers a next user the stable release that surpasses their prerelease", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.14-next.2", channel: "next" },
      { latest: "0.0.14", next: "0.0.14-next.2" }
    );

    expect(notice).toEqual({
      kind: "stable-surpassed",
      currentVersion: "0.0.14-next.2",
      latestVersion: "0.0.14",
    });
  });

  it("prefers the in-channel update when both channels moved", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.14-next.2", channel: "next" },
      { latest: "0.0.14", next: "0.0.15-next.0" }
    );

    expect(notice).toEqual({
      kind: "channel-update",
      channel: "next",
      currentVersion: "0.0.14-next.2",
      latestVersion: "0.0.15-next.0",
    });
  });

  it("notifies a user on any prerelease channel when that channel advances", () => {
    const notice = decideUpdateNotice(
      { version: "1.0.0-beta.1", channel: "beta" },
      { beta: "1.0.0-beta.3", latest: "1.0.0" }
    );

    expect(notice).toEqual({
      kind: "channel-update",
      channel: "beta",
      currentVersion: "1.0.0-beta.1",
      latestVersion: "1.0.0-beta.3",
    });
  });

  it("offers any prerelease user the stable release that surpasses them", () => {
    const notice = decideUpdateNotice(
      { version: "1.0.0-beta.3", channel: "beta" },
      { beta: "1.0.0-beta.3", latest: "1.0.0" }
    );

    expect(notice).toEqual({
      kind: "stable-surpassed",
      currentVersion: "1.0.0-beta.3",
      latestVersion: "1.0.0",
    });
  });

  it("stays silent when everything is up to date", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.14-next.2", channel: "next" },
      { latest: "0.0.13", next: "0.0.14-next.2" }
    );

    expect(notice).toBeUndefined();
  });

  it("ignores malformed tag versions from the registry", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.13", channel: "latest" },
      { latest: "not-a-version" }
    );

    expect(notice).toBeUndefined();
  });
});

describe("formatUpdateNotice", () => {
  it("points an in-channel update at pss update", () => {
    const line = formatUpdateNotice({
      kind: "channel-update",
      channel: "latest",
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
    });

    expect(line).toContain("0.0.13");
    expect(line).toContain("0.0.14");
    expect(line).toContain("pss update");
  });

  it("points a stable-surpassed update at the explicit channel switch", () => {
    const line = formatUpdateNotice({
      kind: "stable-surpassed",
      currentVersion: "0.0.14-next.2",
      latestVersion: "0.0.14",
    });

    expect(line).toContain("0.0.14");
    expect(line).toContain("pss update --channel latest");
  });
});

describe("fetchDistTags", () => {
  it("returns every published dist-tag from one packument request", async () => {
    const urls: string[] = [];
    const tags = await fetchDistTags({
      fetchImpl: (url: string) => {
        urls.push(url);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              "dist-tags": {
                latest: "0.0.14",
                next: "0.0.15-next.0",
                canary: "0.0.16-canary.2",
              },
            }),
        });
      },
    });

    expect(tags).toEqual({
      latest: "0.0.14",
      next: "0.0.15-next.0",
      canary: "0.0.16-canary.2",
    });
    expect(urls).toEqual([
      `${DEFAULT_REGISTRY_BASE_URL}/${encodeURIComponent(CODING_AGENT_PACKAGE_NAME)}`,
    ]);
  });

  it("drops dist-tags whose value is not a valid version", async () => {
    const tags = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              "dist-tags": { latest: "0.0.14", bogus: "not-a-version" },
            }),
        }),
    });

    expect(tags).toEqual({ latest: "0.0.14" });
  });

  it("drops dist-tags whose names are outside the tag charset", async () => {
    const tags = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              "dist-tags": {
                latest: "0.0.14",
                "evil\u001b[31m": "9.9.9",
                "with space": "9.9.9",
              },
            }),
        }),
    });

    expect(tags).toEqual({ latest: "0.0.14" });
  });

  it("reads only own tag entries through publishedTagVersion", () => {
    expect(publishedTagVersion({ latest: "1.0.0" }, "latest")).toBe("1.0.0");
    expect(
      publishedTagVersion({ latest: "1.0.0" }, "toString")
    ).toBeUndefined();
    expect(
      publishedTagVersion({ latest: "1.0.0" }, "constructor")
    ).toBeUndefined();
  });

  it("returns an empty map when the registry fails or the payload is malformed", async () => {
    const rejected = await fetchDistTags({
      fetchImpl: () => Promise.reject(new Error("network down")),
    });
    expect(rejected).toEqual({});

    const notOk = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    });
    expect(notOk).toEqual({});

    const malformed = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: 1 }) }),
    });
    expect(malformed).toEqual({});
  });
});

describe("resolveUpdateRegistryBaseUrl", () => {
  it("defaults to the npm registry", () => {
    expect(resolveUpdateRegistryBaseUrl({})).toBe(DEFAULT_REGISTRY_BASE_URL);
  });

  it("honors the registry override environment variable", () => {
    expect(
      resolveUpdateRegistryBaseUrl({
        PSS_UPDATE_REGISTRY_BASE_URL: "http://127.0.0.1:4873",
      })
    ).toBe("http://127.0.0.1:4873");
  });
});
