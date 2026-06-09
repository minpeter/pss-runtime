import { describe, expect, it } from "vitest";
import {
  mapSearchResults,
  webSearchInputSchema,
  webSearchOutputSchema,
} from "./web-search.js";

describe("webSearch schemas", () => {
  it("maps search results with 1-indexed positions and source", () => {
    const output = mapSearchResults("typescript", [
      {
        engine: "Tavily",
        title: "TypeScript",
        url: "https://example.com/ts",
        snippet: "A typed superset of JavaScript.",
      },
    ]);

    expect(webSearchOutputSchema.parse(output)).toEqual({
      query: "typescript",
      count: 1,
      results: [
        {
          position: 1,
          title: "TypeScript",
          url: "https://example.com/ts",
          snippet: "A typed superset of JavaScript.",
          source: "Tavily",
        },
      ],
    });
  });

  it("rejects empty query", () => {
    expect(() => webSearchInputSchema.parse({ query: "  " })).toThrow();
  });
});