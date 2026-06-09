import { describe, expect, it, vi } from "vitest";
import type { OpenSearchClient } from "@minpeter/opensearch";
import { createWebSearchTool } from "./web-search.js";

interface ExecutableTool {
  execute: (
    input: unknown,
    options?: { abortSignal?: AbortSignal }
  ) => Promise<unknown>;
}

const executeTool = (tool: unknown, input: unknown) =>
  (tool as ExecutableTool).execute(input);

describe("createWebSearchTool", () => {
  it("maps search results to structured output", async () => {
    const search = vi.fn<OpenSearchClient["search"]>().mockResolvedValue([
      {
        engine: "Tavily",
        title: "TypeScript",
        url: "https://example.com/ts",
        snippet: "Typed JavaScript.",
      },
    ]);
    const client = { search, fetch: vi.fn() } satisfies OpenSearchClient;
    const tool = createWebSearchTool(client);

    await expect(executeTool(tool, { query: "typescript" })).resolves.toEqual({
      query: "typescript",
      count: 1,
      results: [
        {
          position: 1,
          title: "TypeScript",
          url: "https://example.com/ts",
          snippet: "Typed JavaScript.",
          source: "Tavily",
        },
      ],
    });
    expect(search).toHaveBeenCalledWith("typescript", 5);
  });

  it("rejects empty query before calling the client", async () => {
    const search = vi.fn<OpenSearchClient["search"]>();
    const client = { search, fetch: vi.fn() } satisfies OpenSearchClient;
    const tool = createWebSearchTool(client);

    await expect(executeTool(tool, { query: "  " })).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });
});