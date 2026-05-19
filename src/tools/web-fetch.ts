import { jsonSchema, tool } from "ai";
import {
  fetchTinyFishPages,
  type TinyFishFetchError,
  type TinyFishFetchOutput,
  type TinyFishFetchRequest,
  type TinyFishFetchResult,
} from "../integrations/tinyfish";
import { readObject, readString } from "../utils/unknown";

export type WebFetchResult = TinyFishFetchResult;
export type WebFetchError = TinyFishFetchError;
export type WebFetchOutput = TinyFishFetchOutput;

const fetchDefaults = {
  format: "markdown",
  image_links: false,
  links: false,
} satisfies Pick<TinyFishFetchRequest, "format" | "image_links" | "links">;

export const webFetchTool = tool({
  description:
    "Fetch and extract readable content from up to 10 absolute HTTP(S) URLs. Use after web_search or when the user provides URLs; markdown is the best default format for LLM context.",
  execute: (input, options): Promise<WebFetchOutput> => {
    const request = parseWebFetchInput(input);

    return fetchTinyFishPages(request, { signal: options?.abortSignal });
  },
  inputSchema: jsonSchema({
    additionalProperties: false,
    description:
      "URLs to fetch. Format and link extraction are intentionally managed by the tool.",
    properties: {
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
    description:
      "Fetched page content plus per-URL failures. Per-URL errors do not prevent other URLs from returning results.",
    properties: {
      errors: {
        description:
          "Per-URL fetch failures. Empty when every requested URL succeeds.",
        items: {
          additionalProperties: false,
          properties: {
            error: {
              description:
                "Structured fetch error code such as page_not_found, timeout, bot_blocked, or invalid_url.",
              type: "string",
            },
            status: {
              description:
                "Upstream HTTP status when the target returned an HTTP error.",
              type: "number",
            },
            url: { description: "URL that failed.", type: "string" },
          },
          required: ["url", "error"],
          type: "object",
        },
        type: "array",
      },
      results: {
        description: "Successfully fetched pages.",
        items: {
          additionalProperties: true,
          properties: {
            final_url: {
              description: "URL after redirects. May differ from url.",
              type: "string",
            },
            format: {
              description: "Format used for text: markdown, html, or json.",
              type: "string",
            },
            image_links: {
              description:
                "Image source URLs found on the page when image_links was requested.",
              items: { type: "string" },
              type: "array",
            },
            links: {
              description:
                "Hyperlink URLs found on the page when links was requested.",
              items: { type: "string" },
              type: "array",
            },
            text: {
              description:
                "Extracted page content. String for markdown/html, structured object for json, or null if unavailable.",
            },
            title: { description: "Page title when detected.", type: "string" },
            url: { description: "Original requested URL.", type: "string" },
          },
          required: ["url", "final_url", "text", "format"],
          type: "object",
        },
        type: "array",
      },
    },
    required: ["results", "errors"],
    type: "object",
  }),
});

function parseWebFetchInput(input: unknown): TinyFishFetchRequest {
  const object = readObject(input);
  const urls = readUrls(object.urls);

  return {
    ...fetchDefaults,
    urls,
  };
}

function readUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("web_fetch requires at least one URL.");
  }

  if (value.length > 10) {
    throw new Error("web_fetch accepts at most 10 URLs per request.");
  }

  return value.map((item) => readHttpUrl(item));
}

function readHttpUrl(value: unknown): string {
  const url = readString(value).trim();

  if (!url) {
    throw new Error("web_fetch URLs must be non-empty strings.");
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(
      "web_fetch URLs must be valid absolute http or https URLs."
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("web_fetch only accepts http and https URLs.");
  }

  return parsedUrl.href;
}
