import { jsonSchema, type Tool, tool } from "ai";
import type { WebToolsClient } from "../client-types.js";
import {
  mapSearchResults,
  resolveSearchResultCount,
  type WebSearchOutput,
  webSearchInputSchema,
  webSearchOutputSchema,
} from "../schemas/web-search.js";

export function createWebSearchTool(
  client: WebToolsClient
): Tool<unknown, WebSearchOutput> {
  return tool({
    description:
      "Search the public web for current or external information. Returns ranked results with titles, snippets, URLs, and source engines; use web_fetch afterward to read full page content.",
    execute: async (input, options): Promise<WebSearchOutput> => {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error("web_search aborted.");
      }

      const parsed = webSearchInputSchema.parse(input);
      const numResults = resolveSearchResultCount(parsed);
      const results = await client.search(parsed.query, numResults);
      return mapSearchResults(parsed.query, results);
    },
    inputSchema: jsonSchema({
      additionalProperties: false,
      properties: {
        query: {
          description:
            "Non-empty natural-language search query. Search operators such as site:example.com may be included.",
          minLength: 1,
          type: "string",
        },
        num_results: {
          description:
            "Optional result count from 1 to 15. Defaults to 5 when omitted.",
          maximum: 15,
          minimum: 1,
          type: "integer",
        },
      },
      required: ["query"],
      type: "object",
    }),
    outputSchema: jsonSchema({
      additionalProperties: false,
      properties: {
        count: { type: "integer" },
        query: { type: "string" },
        results: {
          items: {
            additionalProperties: false,
            properties: {
              position: { type: "integer" },
              snippet: { type: "string" },
              source: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
            },
            required: ["position", "snippet", "source", "title", "url"],
            type: "object",
          },
          type: "array",
        },
      },
      required: ["count", "query", "results"],
      type: "object",
    }),
  });
}

export function parseWebSearchOutput(value: unknown): WebSearchOutput {
  return webSearchOutputSchema.parse(value);
}
