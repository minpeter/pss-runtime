import { z } from "zod";

const searchResultCountSchema = z.int().positive().max(15);

export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  num_results: searchResultCountSchema.optional(),
});

export const webSearchResultItemSchema = z.object({
  position: z.int().positive(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  source: z.string(),
});

export const webSearchOutputSchema = z.object({
  query: z.string(),
  count: z.int().nonnegative(),
  results: z.array(webSearchResultItemSchema),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

export function mapSearchResults(
  query: string,
  results: ReadonlyArray<{
    readonly engine: string;
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }>
): WebSearchOutput {
  return {
    query,
    count: results.length,
    results: results.map((result, index) => ({
      position: index + 1,
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      source: result.engine,
    })),
  };
}

export function resolveSearchResultCount(
  input: Pick<WebSearchInput, "num_results">
): number {
  return input.num_results ?? 5;
}
