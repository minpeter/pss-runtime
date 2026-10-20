import { describe, expect, it, vi } from "vitest";
import { cleanupPrefix } from "./celld-bucket";

const LOOPBACK_ENDPOINT = "http://127.0.0.1:14566";
const EMPTY_LISTING = "<ListBucketResult></ListBucketResult>";

const mockBucketFetch = (pages: readonly string[]) => {
  let listingCount = 0;
  return vi.fn<typeof fetch>((_input, init) => {
    if (init?.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const xml = pages[listingCount] ?? EMPTY_LISTING;
    listingCount += 1;
    return Promise.resolve(new Response(xml));
  });
};

const cleanupOnLoopback = (
  prefix: string,
  fetchImpl: ReturnType<typeof mockBucketFetch>
) => cleanupPrefix(prefix, { endpoint: LOOPBACK_ENDPOINT, fetchImpl });

const requestUrls = (
  fetchImpl: ReturnType<typeof mockBucketFetch>,
  method: "DELETE" | "LIST"
): string[] =>
  fetchImpl.mock.calls
    .filter(([, init]) =>
      method === "DELETE"
        ? init?.method === "DELETE"
        : init?.method !== "DELETE"
    )
    .map(([input]) => String(input));

const objectUrl = (...segments: string[]): string =>
  `${LOOPBACK_ENDPOINT}/pss-celld-qa/${segments.map(encodeURIComponent).join("/")}`;

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
    const fetchImpl = mockBucketFetch([
      "<ListBucketResult><Key>run/initial</Key></ListBucketResult>",
      "<ListBucketResult><Key>run/late</Key></ListBucketResult>",
    ]);

    await expect(cleanupOnLoopback("run", fetchImpl)).rejects.toThrow(
      "not empty after cleanup"
    );
    expect(requestUrls(fetchImpl, "LIST")).toHaveLength(2);
  });

  it("deletes the literal key when listing XML double-escapes an ampersand entity", async () => {
    const fetchImpl = mockBucketFetch([
      "<ListBucketResult><Key>run/&amp;lt;file</Key></ListBucketResult>",
    ]);

    await cleanupOnLoopback("run", fetchImpl);

    expect(requestUrls(fetchImpl, "DELETE")).toEqual([
      objectUrl("run", "&lt;file"),
    ]);
  });

  it("still deletes a key whose listing XML encodes a real less-than character", async () => {
    const fetchImpl = mockBucketFetch([
      "<ListBucketResult><Key>run/&lt;x</Key></ListBucketResult>",
    ]);

    await cleanupOnLoopback("run", fetchImpl);

    expect(requestUrls(fetchImpl, "DELETE")).toEqual([objectUrl("run", "<x")]);
  });

  it("decodes mixed named entities in a nested key once", async () => {
    const fetchImpl = mockBucketFetch([
      "<ListBucketResult><Key>run/sub/&quot;&lt;a&amp;b&gt;&apos;</Key></ListBucketResult>",
    ]);

    await cleanupOnLoopback("run", fetchImpl);

    expect(requestUrls(fetchImpl, "DELETE")).toEqual([
      objectUrl("run", "sub", `"<a&b>'`),
    ]);
  });

  it("keeps a double-escaped prefix inside the cleanup boundary", async () => {
    const fetchImpl = mockBucketFetch([
      "<ListBucketResult><Key>run/&amp;lt;/file</Key></ListBucketResult>",
    ]);

    await cleanupOnLoopback("run/&lt;", fetchImpl);

    expect(requestUrls(fetchImpl, "DELETE")).toEqual([
      objectUrl("run", "&lt;", "file"),
    ]);
  });

  it("decodes NextContinuationToken once before the next listing request", async () => {
    const fetchImpl = mockBucketFetch([
      "<ListBucketResult><NextContinuationToken>&amp;lt;</NextContinuationToken></ListBucketResult>",
    ]);

    await cleanupOnLoopback("run", fetchImpl);

    expect(
      requestUrls(fetchImpl, "LIST").map((url) =>
        new URL(url).searchParams.get("continuation-token")
      )
    ).toEqual([null, "&lt;", null]);
  });
});
