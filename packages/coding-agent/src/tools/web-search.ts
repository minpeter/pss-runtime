import { jsonSchema, tool } from "ai";
import {
  searchTinyFishWeb,
  type TinyFishSearchOutput,
  type TinyFishSearchRequest,
  type TinyFishSearchResult,
} from "../integrations/tinyfish";
import { readObject, readString } from "../utils/unknown";

export type WebSearchResult = TinyFishSearchResult;
export type WebSearchOutput = TinyFishSearchOutput;

export const webSearchTool = tool({
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
    description:
      "A ranked web search result page. Fetch returned URLs with web_fetch when page content is needed.",
    properties: {
      page: {
        description: "Zero-based page number returned by the provider.",
        type: "number",
      },
      query: { description: "Search query that was executed.", type: "string" },
      results: {
        description: "Ranked search results for the query.",
        items: {
          additionalProperties: false,
          properties: {
            position: {
              description: "One-based position in the result page.",
              type: "number",
            },
            site_name: {
              description: "Domain or site name for the result.",
              type: "string",
            },
            snippet: {
              description: "Short text snippet from the search result.",
              type: "string",
            },
            title: { description: "Page title.", type: "string" },
            url: {
              description: "Absolute URL for the result.",
              type: "string",
            },
          },
          required: ["position", "site_name", "title", "snippet", "url"],
          type: "object",
        },
        type: "array",
      },
      total_results: {
        description: "Total number of results returned for this page.",
        type: "number",
      },
    },
    required: ["query", "results", "total_results", "page"],
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
