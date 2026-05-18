import { jsonSchema, tool } from "ai";
import {
  fetchTinyFishPages,
  readObject,
  readString,
  type TinyFishFetchError,
  type TinyFishFetchOutput,
  type TinyFishFetchRequest,
  type TinyFishFetchResult,
  tinyFishFetchFormats,
} from "../integrations/tinyfish";

export type WebFetchResult = TinyFishFetchResult;
export type WebFetchError = TinyFishFetchError;
export type WebFetchOutput = TinyFishFetchOutput;

export const webFetchTool = tool({
  description:
    "Fetch and extract clean page content with TinyFish Fetch API. Supports markdown, HTML, and JSON output plus optional links.",
  execute: (input): Promise<WebFetchOutput> => {
    const request = parseWebFetchInput(input);

    return fetchTinyFishPages(request);
  },
  inputSchema: jsonSchema({
    additionalProperties: false,
    properties: {
      format: {
        default: "markdown",
        enum: tinyFishFetchFormats,
        type: "string",
      },
      image_links: { default: false, type: "boolean" },
      links: { default: false, type: "boolean" },
      urls: {
        items: { format: "uri", type: "string" },
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
            status: { type: "number" },
            url: { type: "string" },
          },
          required: ["url", "error"],
          type: "object",
        },
        type: "array",
      },
      results: {
        items: {
          additionalProperties: true,
          properties: {
            final_url: { type: "string" },
            format: { type: "string" },
            image_links: { items: { type: "string" }, type: "array" },
            links: { items: { type: "string" }, type: "array" },
            text: {},
            title: { type: "string" },
            url: { type: "string" },
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
    format: readFormat(object.format),
    image_links: object.image_links === true,
    links: object.links === true,
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

  const parsedUrl = new URL(url);

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("web_fetch only accepts http and https URLs.");
  }

  return url;
}

function readFormat(value: unknown): TinyFishFetchRequest["format"] {
  if (value === undefined) {
    return "markdown";
  }

  if (tinyFishFetchFormats.includes(value as TinyFishFetchRequest["format"])) {
    return value as TinyFishFetchRequest["format"];
  }

  throw new Error("web_fetch format must be one of markdown, html, or json.");
}
