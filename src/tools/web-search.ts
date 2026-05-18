import { jsonSchema, tool } from "ai";
import {
  getTinyFishApiKey,
  parseTinyFishJsonResponse,
  readNumber,
  readObject,
  readString,
} from "./tinyfish";

const searchEndpoint = "https://api.search.tinyfish.ai";

interface TinyFishSearchResponse {
  page?: unknown;
  query?: unknown;
  results?: unknown;
  total_results?: unknown;
}

export interface WebSearchResult {
  position: number;
  site_name: string;
  snippet: string;
  title: string;
  url: string;
}

export interface WebSearchOutput {
  page: number;
  query: string;
  results: WebSearchResult[];
  total_results: number;
}

interface WebSearchInput {
  language: string;
  location: string;
  page: number;
  query: string;
}

export const webSearchTool = tool({
  description:
    "Search the web with TinyFish Search API. Returns ranked results with titles, snippets, and URLs.",
  execute: async (input): Promise<WebSearchOutput> => {
    const request = parseWebSearchInput(input);
    const url = new URL(searchEndpoint);
    url.searchParams.set("query", request.query);
    url.searchParams.set("location", request.location);
    url.searchParams.set("language", request.language);
    url.searchParams.set("page", String(request.page));

    const response = await fetch(url.toString(), {
      headers: { "X-API-Key": getTinyFishApiKey() },
      method: "GET",
    });
    const body = await parseTinyFishJsonResponse<TinyFishSearchResponse>(
      response,
      "search"
    );

    return sanitizeSearchResponse(body);
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

function parseWebSearchInput(input: unknown): WebSearchInput {
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

function sanitizeSearchResponse(
  response: TinyFishSearchResponse
): WebSearchOutput {
  const results = Array.isArray(response.results) ? response.results : [];

  return {
    page: readNumber(response.page),
    query: readString(response.query),
    results: results.map(sanitizeSearchResult),
    total_results: readNumber(response.total_results),
  };
}

function sanitizeSearchResult(value: unknown): WebSearchResult {
  const object = readObject(value);

  return {
    position: readNumber(object.position),
    site_name: readString(object.site_name),
    snippet: readString(object.snippet),
    title: readString(object.title),
    url: readString(object.url),
  };
}
