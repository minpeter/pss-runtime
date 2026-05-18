import { jsonSchema, tool } from "ai";
import {
  getTinyFishApiKey,
  parseTinyFishJsonResponse,
  readObject,
  readOptionalNumber,
  readOptionalString,
  readString,
  readStringArray,
} from "./tinyfish";

const fetchEndpoint = "https://api.fetch.tinyfish.ai";
const fetchFormats = ["markdown", "html", "json"] as const;

type WebFetchFormat = (typeof fetchFormats)[number];

type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface WebFetchInput {
  format: WebFetchFormat;
  image_links: boolean;
  links: boolean;
  urls: string[];
}

interface TinyFishFetchResponse {
  errors?: unknown;
  results?: unknown;
}

export interface WebFetchResult {
  author?: string;
  description?: string;
  final_url: string;
  format: string;
  image_links?: string[];
  language?: string;
  latency_ms?: number;
  links?: string[];
  published_date?: string;
  text: JsonValue;
  title?: string;
  url: string;
}

export interface WebFetchError {
  error: string;
  status?: number;
  url: string;
}

export interface WebFetchOutput {
  errors: WebFetchError[];
  results: WebFetchResult[];
}

export const webFetchTool = tool({
  description:
    "Fetch and extract clean page content with TinyFish Fetch API. Supports markdown, HTML, and JSON output plus optional links.",
  execute: async (input): Promise<WebFetchOutput> => {
    const request = parseWebFetchInput(input);
    const response = await fetch(fetchEndpoint, {
      body: JSON.stringify(request),
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": getTinyFishApiKey(),
      },
      method: "POST",
    });
    const body = await parseTinyFishJsonResponse<TinyFishFetchResponse>(
      response,
      "fetch"
    );

    return sanitizeFetchResponse(body);
  },
  inputSchema: jsonSchema({
    additionalProperties: false,
    properties: {
      format: { default: "markdown", enum: fetchFormats, type: "string" },
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

function parseWebFetchInput(input: unknown): WebFetchInput {
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

function readFormat(value: unknown): WebFetchFormat {
  if (value === undefined) {
    return "markdown";
  }

  if (fetchFormats.includes(value as WebFetchFormat)) {
    return value as WebFetchFormat;
  }

  throw new Error("web_fetch format must be one of markdown, html, or json.");
}

function sanitizeFetchResponse(
  response: TinyFishFetchResponse
): WebFetchOutput {
  const results = Array.isArray(response.results) ? response.results : [];
  const errors = Array.isArray(response.errors) ? response.errors : [];

  return {
    errors: errors.map(sanitizeFetchError),
    results: results.map(sanitizeFetchResult),
  };
}

function sanitizeFetchResult(value: unknown): WebFetchResult {
  const object = readObject(value);
  const result: WebFetchResult = {
    final_url: readString(object.final_url),
    format: readString(object.format),
    text: normalizeJsonValue(object.text),
    url: readString(object.url),
  };
  const optionalStrings = {
    author: readOptionalString(object.author),
    description: readOptionalString(object.description),
    language: readOptionalString(object.language),
    published_date: readOptionalString(object.published_date),
    title: readOptionalString(object.title),
  };
  const latencyMs = readOptionalNumber(object.latency_ms);
  const links = readStringArray(object.links);
  const imageLinks = readStringArray(object.image_links);

  for (const [key, optionalValue] of Object.entries(optionalStrings)) {
    if (optionalValue !== undefined) {
      result[key as keyof typeof optionalStrings] = optionalValue;
    }
  }

  if (latencyMs !== undefined) {
    result.latency_ms = latencyMs;
  }

  if (links !== undefined) {
    result.links = links;
  }

  if (imageLinks !== undefined) {
    result.image_links = imageLinks;
  }

  return result;
}

function sanitizeFetchError(value: unknown): WebFetchError {
  const object = readObject(value);
  const error: WebFetchError = {
    error: readString(object.error),
    url: readString(object.url),
  };
  const status = readOptionalNumber(object.status);

  if (status !== undefined) {
    error.status = status;
  }

  return error;
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }

  if (typeof value === "object" && value !== null) {
    const normalized: { [key: string]: JsonValue } = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      normalized[key] = normalizeJsonValue(nestedValue);
    }

    return normalized;
  }

  return null;
}
