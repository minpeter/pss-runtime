import { jsonSchema, type Tool, tool } from "ai";
import {
  searchTinyFishWeb,
  type TinyFishSearchOutput,
  type TinyFishSearchRequest,
  type TinyFishSearchResult,
} from "../integrations/tinyfish";
import { readObject, readString } from "../utils/unknown";

export type WebSearchResult = TinyFishSearchResult;
export type WebSearchOutput = TinyFishSearchOutput;

export const webSearchTool: Tool<unknown, WebSearchOutput> = tool({
  description:
    "Search the public web for current or external information. Returns ranked results with titles, snippets, and URLs; use web_fetch afterward to read full page content.",
  execute: (input, options): Promise<WebSearchOutput> => {
    const request = parseWebSearchInput(input);

    return searchTinyFishWeb(request, { signal: options?.abortSignal });
  },
  inputSchema: jsonSchema({
    additionalProperties: false,
    description:
      "Search query. Locale and pagination are intentionally managed by the tool.",
    properties: {
      query: {
        description:
          "Non-empty search query. Search operators such as site:example.com or -site:example.com may be included.",
        minLength: 1,
        type: "string",
      },
    },
    required: ["query"],
    type: "object",
  }),
  outputSchema: jsonSchema({
    additionalProperties: false,
    properties: {
      page: { type: "number" },
      query: { type: "string" },
      results: {
        items: {
          additionalProperties: false,
          properties: {
            position: { type: "number" },
            site_name: { type: "string" },
            snippet: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
          },
          required: ["position", "site_name", "snippet", "title", "url"],
          type: "object",
        },
        type: "array",
      },
      total_results: { type: "number" },
    },
    required: ["page", "query", "results", "total_results"],
    type: "object",
  }),
});

function parseWebSearchInput(input: unknown): TinyFishSearchRequest {
  const object = readObject(input);
  const query = readString(object.query).trim();

  if (!query) {
    throw new Error("web_search requires a non-empty query string.");
  }

  return {
    language: "en",
    location: "US",
    page: 0,
    query,
  };
}
