import { describe, expect, it, vi } from "vitest";

import {
  createWebTools,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type WebFetchToolResult,
  type WebSearchToolResult,
} from "./web-tools";

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    context: undefined,
    messages: [] as [],
    toolCallId: "call-1",
  };
}

describe("web tools", () => {
  it("web_search maps Firecrawl web results", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            web: [
              {
                description: "Docs",
                title: "Firecrawl",
                url: "https://docs.firecrawl.dev",
              },
            ],
          },
          success: true,
        }),
        { status: 200 }
      )
    );
    const tools = createWebTools({
      fetchImpl,
      firecrawlApiKey: "fc-test",
    });

    const result = (await tools[WEB_SEARCH_TOOL_NAME]?.execute?.(
      { query: "firecrawl docs" },
      toolContext()
    )) as WebSearchToolResult;

    expect(result).toEqual({
      ok: true,
      provider: "firecrawl",
      query: "firecrawl docs",
      resultCount: 1,
      results: [
        {
          description: "Docs",
          title: "Firecrawl",
          url: "https://docs.firecrawl.dev",
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.firecrawl.dev/v2/search",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("web_fetch falls back to jina when firecrawl scrape fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(
        new Response("# Hello page\n\nBody", { status: 200 })
      );
    const tools = createWebTools({ fetchImpl });

    const result = (await tools[WEB_FETCH_TOOL_NAME]?.execute?.(
      { url: "https://example.com/page" },
      toolContext()
    )) as WebFetchToolResult;

    expect(result).toEqual({
      markdown: "# Hello page\n\nBody",
      provider: "jina",
      title: null,
      url: "https://example.com/page",
    });
  });
});
