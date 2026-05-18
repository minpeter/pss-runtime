import { jsonSchema, tool } from "ai";
import {
  readObject,
  readString,
  searchTinyFishWeb,
  type TinyFishSearchOutput,
  type TinyFishSearchRequest,
  type TinyFishSearchResult,
} from "../integrations/tinyfish";

export type WebSearchResult = TinyFishSearchResult;
export type WebSearchOutput = TinyFishSearchOutput;

export const webSearchTool = tool({
  description:
    "Search the web with TinyFish Search API. Returns ranked results with titles, snippets, and URLs.",
  execute: (input): Promise<WebSearchOutput> => {
    const request = parseWebSearchInput(input);

    return searchTinyFishWeb(request);
  },
  inputSchema: jsonSchema({
    additionalProperties: false,
    properties: {
      language: { default: "en", type: "string" },
      location: { default: "US", type: "string" },
      page: { default: 0, maximum: 10, minimum: 0, type: "integer" },
      query: { minLength: 1, type: "string" },
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
          required: ["position", "site_name", "title", "snippet", "url"],
          type: "object",
        },
        type: "array",
      },
      total_results: { type: "number" },
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
    language: readString(object.language).trim() || "en",
    location: readString(object.location).trim() || "US",
    page: readPage(object.page),
    query,
  };
}

function readPage(value: unknown): number {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isInteger(value) || typeof value !== "number") {
    throw new Error("web_search page must be an integer between 0 and 10.");
  }

  if (value < 0 || value > 10) {
    throw new Error("web_search page must be between 0 and 10.");
  }

  return value;
}
