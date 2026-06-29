import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createCodingAgentTools, resolveStartTuiTools } from "./tools";

const toolExecutionOptions: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "tool-call-test",
};

const searchResult = {
  engine: "DuckDuckGo",
  snippet: "Typed JavaScript at scale.",
  title: "TypeScript",
  url: "https://www.typescriptlang.org/",
};

const fetchResult = {
  content: "# Example\nReadable content.",
  length: 27,
  title: "Example",
  url: "https://example.com/",
};

describe("coding-agent web tools", () => {
  it("creates OpenSearch-backed web_search and web_fetch tools", async () => {
    const client = {
      fetch: vi.fn().mockResolvedValue([fetchResult]),
      search: vi.fn().mockResolvedValue([searchResult]),
    };

    const tools = createCodingAgentTools({ client });
    const searchExecute = tools.web_search.execute;
    const fetchExecute = tools.web_fetch.execute;

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
    expect(typeof searchExecute).toBe("function");
    expect(typeof fetchExecute).toBe("function");
    if (
      typeof searchExecute !== "function" ||
      typeof fetchExecute !== "function"
    ) {
      throw new TypeError("Expected executable web tools.");
    }

    await expect(
      searchExecute(
        { numResults: 3, query: "typescript docs" },
        toolExecutionOptions
      )
    ).resolves.toStrictEqual([searchResult]);
    await expect(
      fetchExecute(
        { maxCharacters: 8000, urls: ["https://example.com/"] },
        toolExecutionOptions
      )
    ).resolves.toStrictEqual([fetchResult]);
    expect(client.search).toHaveBeenCalledWith("typescript docs", 3);
    expect(client.fetch).toHaveBeenCalledWith(["https://example.com/"], {
      maxCharacters: 8000,
    });
  });

  it("uses OpenSearch tools by default for the TUI and preserves overrides", () => {
    const defaultTools = resolveStartTuiTools();
    const overrideTools = { custom_tool: defaultTools.web_search };

    expect(Object.keys(defaultTools)).toStrictEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(resolveStartTuiTools(overrideTools)).toBe(overrideTools);
  });
});
