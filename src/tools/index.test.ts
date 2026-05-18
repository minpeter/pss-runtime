import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTinyFishApiKey } from "../integrations/tinyfish";
import { tools } from ".";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";

interface ExecutableTool {
  execute: (input: unknown) => Promise<unknown> | unknown;
}

const missingApiKeyPattern = /TINYFISH_API_KEY/;
const nonRateLimitErrorPattern = /HTTP 401: invalid api key/;
const rateLimitExhaustedPattern =
  /HTTP 429: rate limit exceeded\. Retry-After: 60\. \(all 2 configured TinyFish API keys returned HTTP 429\)/;
const tooManyUrlsPattern = /10 URLs/;

const executeTool = async (tool: unknown, input: unknown) =>
  (tool as ExecutableTool).execute(input);

const originalTinyFishApiKey = process.env.TINYFISH_API_KEY;

describe("tools", () => {
  it("exports real web tools through the shared tools map", () => {
    expect(Object.keys(tools).sort()).toEqual(["web_fetch", "web_search"]);
    expect(tools.web_search).toBe(webSearchTool);
    expect(tools.web_fetch).toBe(webFetchTool);
    expect("continue" in tools).toBe(false);
  });
});

describe("web tools", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.TINYFISH_API_KEY = "tf-test-key";
  });

  afterEach(() => {
    if (originalTinyFishApiKey === undefined) {
      delete process.env.TINYFISH_API_KEY;
    } else {
      process.env.TINYFISH_API_KEY = originalTinyFishApiKey;
    }
    vi.unstubAllGlobals();
  });

  it("rejects clearly when TINYFISH_API_KEY is missing", async () => {
    delete process.env.TINYFISH_API_KEY;

    await expect(
      executeTool(webSearchTool, { query: "tinyfish" })
    ).rejects.toThrow(missingApiKeyPattern);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects clearly when TINYFISH_API_KEY has no usable semicolon segments", async () => {
    process.env.TINYFISH_API_KEY = " ; \t ; ";

    await expect(
      executeTool(webSearchTool, { query: "tinyfish" })
    ).rejects.toThrow(missingApiKeyPattern);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes and rotates semicolon-delimited TinyFish API keys", () => {
    process.env.TINYFISH_API_KEY = " tf-token-1 ; ; tf-token-2 ";

    expect(getTinyFishApiKey()).toBe("tf-token-1");
    expect(getTinyFishApiKey()).toBe("tf-token-2");
    expect(getTinyFishApiKey()).toBe("tf-token-1");
  });

  it("web_search rotates TinyFish API keys across calls", async () => {
    process.env.TINYFISH_API_KEY = "tf-token-1;tf-token-2";
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            page: 0,
            query: "tinyfish",
            results: [],
            total_results: 0,
          }),
          { status: 200 }
        )
      )
    );

    await executeTool(webSearchTool, { query: "tinyfish" });
    await executeTool(webSearchTool, { query: "tinyfish" });

    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "X-API-Key": "tf-token-1" }),
      expect.objectContaining({ "X-API-Key": "tf-token-2" }),
    ]);
  });

  it("web_search retries the next TinyFish API key after HTTP 429", async () => {
    process.env.TINYFISH_API_KEY = "tf-retry-1;tf-retry-2";
    fetchMock
      .mockResolvedValueOnce(
        new Response("rate limit response can be plain text", { status: 429 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            page: 0,
            query: "tinyfish",
            results: [],
            total_results: 0,
          }),
          { status: 200 }
        )
      );

    const output = await executeTool(webSearchTool, { query: "tinyfish" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "X-API-Key": "tf-retry-1" }),
      expect.objectContaining({ "X-API-Key": "tf-retry-2" }),
    ]);
    expect(output).toEqual({
      page: 0,
      query: "tinyfish",
      results: [],
      total_results: 0,
    });
  });

  it("web_search stops after every TinyFish API key returns HTTP 429", async () => {
    process.env.TINYFISH_API_KEY = "tf-exhaust-1;tf-exhaust-2";
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "rate limit exceeded" } }),
          { headers: { "Retry-After": "60" }, status: 429 }
        )
      )
    );

    await expect(
      executeTool(webSearchTool, { query: "tinyfish" })
    ).rejects.toThrow(rateLimitExhaustedPattern);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "X-API-Key": "tf-exhaust-1" }),
      expect.objectContaining({ "X-API-Key": "tf-exhaust-2" }),
    ]);
  });

  it("web_search does not hide non-rate-limit TinyFish errors by trying another key", async () => {
    process.env.TINYFISH_API_KEY = "tf-invalid-1;tf-invalid-2";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
      })
    );

    await expect(
      executeTool(webSearchTool, { query: "tinyfish" })
    ).rejects.toThrow(nonRateLimitErrorPattern);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ "X-API-Key": "tf-invalid-1" })
    );
  });

  it("web_search calls TinyFish search with query parameters and API key", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          page: 2,
          query: "tinyfish docs",
          results: [
            {
              position: 1,
              site_name: "docs.tinyfish.ai",
              snippet: "TinyFish docs snippet",
              title: "TinyFish Docs",
              url: "https://docs.tinyfish.ai/",
            },
          ],
          total_results: 1,
        }),
        { status: 200 }
      )
    );

    const output = await executeTool(webSearchTool, {
      language: "ko",
      location: "KR",
      page: 2,
      query: "tinyfish docs",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.origin).toBe("https://api.search.tinyfish.ai");
    expect(parsedUrl.searchParams.get("query")).toBe("tinyfish docs");
    expect(parsedUrl.searchParams.get("location")).toBe("KR");
    expect(parsedUrl.searchParams.get("language")).toBe("ko");
    expect(parsedUrl.searchParams.get("page")).toBe("2");
    expect(init?.headers).toMatchObject({ "X-API-Key": "tf-test-key" });
    expect(output).toEqual({
      page: 2,
      query: "tinyfish docs",
      results: [
        {
          position: 1,
          site_name: "docs.tinyfish.ai",
          snippet: "TinyFish docs snippet",
          title: "TinyFish Docs",
          url: "https://docs.tinyfish.ai/",
        },
      ],
      total_results: 1,
    });
  });

  it("web_fetch posts URLs and returns parsed results with per-URL errors", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [
            { error: "page_not_found", status: 404, url: "https://x.test/404" },
          ],
          results: [
            {
              final_url: "https://example.com/",
              format: "markdown",
              links: ["https://example.com/more"],
              text: "Example body",
              title: "Example Domain",
              url: "https://example.com",
            },
          ],
        }),
        { status: 200 }
      )
    );

    const output = await executeTool(webFetchTool, {
      format: "markdown",
      image_links: false,
      links: true,
      urls: ["https://example.com", "https://x.test/404"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.fetch.tinyfish.ai");
    expect(init).toMatchObject({
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "tf-test-key",
      },
      method: "POST",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      format: "markdown",
      image_links: false,
      links: true,
      urls: ["https://example.com", "https://x.test/404"],
    });
    expect(output).toEqual({
      errors: [
        { error: "page_not_found", status: 404, url: "https://x.test/404" },
      ],
      results: [
        {
          final_url: "https://example.com/",
          format: "markdown",
          links: ["https://example.com/more"],
          text: "Example body",
          title: "Example Domain",
          url: "https://example.com",
        },
      ],
    });
  });

  it("web_fetch retries the same request with the next TinyFish API key after HTTP 429", async () => {
    process.env.TINYFISH_API_KEY = "tf-fetch-1;tf-fetch-2";
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "rate limit exceeded" } }),
          { status: 429 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [],
            results: [
              {
                final_url: "https://example.com/",
                format: "markdown",
                text: "Example body",
                url: "https://example.com",
              },
            ],
          }),
          { status: 200 }
        )
      );

    const output = await executeTool(webFetchTool, {
      urls: ["https://example.com"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "X-API-Key": "tf-fetch-1" }),
      expect.objectContaining({ "X-API-Key": "tf-fetch-2" }),
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    ).toEqual([
      {
        format: "markdown",
        image_links: false,
        links: false,
        urls: ["https://example.com"],
      },
      {
        format: "markdown",
        image_links: false,
        links: false,
        urls: ["https://example.com"],
      },
    ]);
    expect(output).toEqual({
      errors: [],
      results: [
        {
          final_url: "https://example.com/",
          format: "markdown",
          text: "Example body",
          url: "https://example.com",
        },
      ],
    });
  });

  it("web_fetch rejects more than ten URLs before making a network call", async () => {
    const urls = Array.from(
      { length: 11 },
      (_, index) => `https://example.com/${index}`
    );

    await expect(executeTool(webFetchTool, { urls })).rejects.toThrow(
      tooManyUrlsPattern
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
