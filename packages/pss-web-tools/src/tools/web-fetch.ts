import type { OpenSearchClient } from "@minpeter/opensearch";
import { jsonSchema, type Tool, tool } from "ai";
import {
  resolveFetchMaxCharacters,
  webFetchInputSchema,
  webFetchOutputSchema,
  type WebFetchOutput,
} from "../schemas/web-fetch.js";

function readFetchError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function createWebFetchTool(
  client: OpenSearchClient
): Tool<unknown, WebFetchOutput> {
  return tool({
    description:
      "Fetch and extract readable markdown content from up to 10 absolute HTTP(S) URLs. Use after web_search or when the user provides URLs.",
    execute: async (input, options): Promise<WebFetchOutput> => {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error("web_fetch aborted.");
      }

      const parsed = webFetchInputSchema.parse(input);
      const maxCharacters = resolveFetchMaxCharacters(parsed);
      const output: WebFetchOutput = { results: [], errors: [] };

      await Promise.all(
        parsed.urls.map(async (url) => {
          try {
            const result = await client.fetch(url, { maxCharacters });
            if (Array.isArray(result)) {
              throw new Error("web_fetch expected a single URL result.");
            }

            output.results.push({
              url: result.url,
              title: result.title,
              content: result.content,
              length: result.length,
            });
          } catch (error) {
            output.errors.push({
              url,
              error: readFetchError(error),
            });
          }
        })
      );

      return output;
    },
    inputSchema: jsonSchema({
      additionalProperties: false,
      properties: {
        max_characters: {
          description:
            "Optional per-page character cap. Defaults to 12000 when omitted.",
          minimum: 1,
          type: "integer",
        },
        urls: {
          description:
            "Absolute http or https URLs to fetch. Maximum 10 URLs per request.",
          items: {
            description: "Absolute http or https URL.",
            format: "uri",
            type: "string",
          },
          maxItems: 10,
          minItems: 1,
          type: "array",
        },
      },
      required: ["urls"],
      type: "object",
    }),
    outputSchema: jsonSchema({
      additionalProperties: false,
      properties: {
        errors: {
          items: {
            additionalProperties: false,
            properties: {
              error: { type: "string" },
              url: { type: "string" },
            },
            required: ["error", "url"],
            type: "object",
          },
          type: "array",
        },
        results: {
          items: {
            additionalProperties: false,
            properties: {
              content: { type: "string" },
              length: { type: "integer" },
              title: { type: "string" },
              url: { type: "string" },
            },
            required: ["content", "length", "title", "url"],
            type: "object",
          },
          type: "array",
        },
      },
      required: ["errors", "results"],
      type: "object",
    }),
  });
}

export function parseWebFetchOutput(value: unknown): WebFetchOutput {
  return webFetchOutputSchema.parse(value);
}