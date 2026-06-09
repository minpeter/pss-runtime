import { z } from "zod";

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "web_fetch URLs must be valid absolute http or https URLs.",
      });
      return;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "web_fetch only accepts http and https URLs.",
      });
    }
  });

export const webFetchInputSchema = z.object({
  urls: z.array(httpUrlSchema).min(1).max(10),
  max_characters: z.int().positive().optional(),
});

export const webFetchResultItemSchema = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  length: z.int().nonnegative(),
});

export const webFetchErrorItemSchema = z.object({
  url: z.string(),
  error: z.string(),
});

export const webFetchOutputSchema = z.object({
  results: z.array(webFetchResultItemSchema),
  errors: z.array(webFetchErrorItemSchema),
});

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
export type WebFetchOutput = z.infer<typeof webFetchOutputSchema>;

export const defaultFetchMaxCharacters = 12_000;

export function resolveFetchMaxCharacters(
  input: Pick<WebFetchInput, "max_characters">
): number {
  return input.max_characters ?? defaultFetchMaxCharacters;
}