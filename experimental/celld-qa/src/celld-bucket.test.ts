import { describe, expect, it, vi } from "vitest";
import { cleanupPrefix } from "./celld-bucket";

describe("Celld bucket cleanup boundary", () => {
  it("rejects a remote endpoint before issuing requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      cleanupPrefix("unsafe", {
        endpoint: "https://s3.example.com",
        fetchImpl,
      })
    ).rejects.toThrow("Celld QA endpoint must be loopback");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds concurrent object deletion for large prefixes", async () => {
    const keys = Array.from({ length: 40 }, (_, index) => `run/key-${index}`);
    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    let listingCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method !== "DELETE") {
        listingCount += 1;
        const listedKeys = listingCount === 1 ? keys : [];
        return new Response(
          `<ListBucketResult>${listedKeys.map((key) => `<Key>${key}</Key>`).join("")}</ListBucketResult>`
        );
      }
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      await Promise.resolve();
      activeDeletes -= 1;
      return new Response(null, { status: 204 });
    });

    await cleanupPrefix("run", {
      endpoint: "http://127.0.0.1:14566",
      fetchImpl,
    });

    expect(maxActiveDeletes).toBeLessThanOrEqual(16);
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")
    ).toHaveLength(keys.length);
    expect(listingCount).toBe(2);
  });

  it("refuses to delete keys outside the requested prefix", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          "<ListBucketResult><Key>run/owned</Key><Key>other/foreign</Key></ListBucketResult>"
        )
      )
    );

    await expect(
      cleanupPrefix("run", {
        endpoint: "http://127.0.0.1:14566",
        fetchImpl,
      })
    ).rejects.toThrow("outside cleanup prefix");
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")
    ).toHaveLength(0);
  });

  it("fails when the final verification still finds an object", async () => {
    let listingCount = 0;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      listingCount += 1;
      return Promise.resolve(
        new Response(
          `<ListBucketResult><Key>run/${listingCount === 1 ? "initial" : "late"}</Key></ListBucketResult>`
        )
      );
    });

    await expect(
      cleanupPrefix("run", {
        endpoint: "http://127.0.0.1:14566",
        fetchImpl,
      })
    ).rejects.toThrow("not empty after cleanup");
    expect(listingCount).toBe(2);
  });

  it("deletes the literal key when listing XML double-escapes an ampersand entity", async () => {
    let listingCount = 0;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      listingCount += 1;
      return Promise.resolve(
        new Response(
          listingCount === 1
            ? "<ListBucketResult><Key>run/&amp;lt;file</Key></ListBucketResult>"
            : "<ListBucketResult></ListBucketResult>"
        )
      );
    });

    await cleanupPrefix("run", {
      endpoint: "http://127.0.0.1:14566",
      fetchImpl,
    });

    expect(
      fetchImpl.mock.calls
        .filter(([, init]) => init?.method === "DELETE")
        .map(([input]) => String(input))
    ).toEqual([
      `http://127.0.0.1:14566/pss-celld-qa/run/${encodeURIComponent("&lt;file")}`,
    ]);
  });

  it("still deletes a key whose listing XML encodes a real less-than character", async () => {
    let listingCount = 0;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      listingCount += 1;
      return Promise.resolve(
        new Response(
          listingCount === 1
            ? "<ListBucketResult><Key>run/&lt;x</Key></ListBucketResult>"
            : "<ListBucketResult></ListBucketResult>"
        )
      );
    });

    await cleanupPrefix("run", {
      endpoint: "http://127.0.0.1:14566",
      fetchImpl,
    });

    expect(
      fetchImpl.mock.calls
        .filter(([, init]) => init?.method === "DELETE")
        .map(([input]) => String(input))
    ).toEqual([
      `http://127.0.0.1:14566/pss-celld-qa/run/${encodeURIComponent("<x")}`,
    ]);
  });

  it("decodes NextContinuationToken once before the next listing request", async () => {
    let listingCount = 0;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      listingCount += 1;
      return Promise.resolve(
        new Response(
          listingCount === 1
            ? "<ListBucketResult><NextContinuationToken>&amp;lt;</NextContinuationToken></ListBucketResult>"
            : "<ListBucketResult></ListBucketResult>"
        )
      );
    });

    await cleanupPrefix("run", {
      endpoint: "http://127.0.0.1:14566",
      fetchImpl,
    });

    const listingUrls = fetchImpl.mock.calls
      .filter(([, init]) => init?.method !== "DELETE")
      .map(([input]) => new URL(String(input)));
    expect(listingUrls).toHaveLength(3);
    expect(listingUrls[0]?.searchParams.get("continuation-token")).toBeNull();
    expect(listingUrls[1]?.searchParams.get("continuation-token")).toBe("&lt;");
    expect(listingUrls[2]?.searchParams.get("continuation-token")).toBeNull();
  });
});
