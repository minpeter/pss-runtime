import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tools } from ".";
import { getTinyFishApiKey } from "./tinyfish";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";

interface ExecutableTool {
  execute: (input: unknown) => Promise<unknown> | unknown;
}

const missingApiKeyPattern = /TINYFISH_API_KEY/;
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
