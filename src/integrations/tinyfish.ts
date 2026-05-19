import { z } from "zod";
import {
  readObject,
  readOptionalNumber,
  readOptionalString,
  readRequiredNumber,
  readRequiredString,
  readStringArray,
} from "../utils/unknown";

const fetchEndpoint = "https://api.fetch.tinyfish.ai";
const requiredApiKeyError =
  "TINYFISH_API_KEY is required to use the built-in TinyFish web tools.";
const searchEndpoint = "https://api.search.tinyfish.ai";
const tinyFishApiKeyPoolSchema = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(";")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
  );

export const tinyFishFetchFormats = ["markdown", "html", "json"] as const;

export type TinyFishFetchFormat = (typeof tinyFishFetchFormats)[number];

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TinyFishFetchRequest {
  format: TinyFishFetchFormat;
  image_links: boolean;
  links: boolean;
  urls: string[];
}

interface TinyFishFetchResponse {
  errors?: unknown;
  results?: unknown;
}

export interface TinyFishFetchResult {
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

export interface TinyFishFetchError {
  error: string;
  status?: number;
  url: string;
}

export interface TinyFishFetchOutput {
  errors: TinyFishFetchError[];
  results: TinyFishFetchResult[];
}

interface TinyFishSearchResponse {
  page?: unknown;
  query?: unknown;
  results?: unknown;
  total_results?: unknown;
}

export interface TinyFishSearchRequest {
  language: string;
  location: string;
  page: number;
  query: string;
}

export interface TinyFishSearchResult {
  position: number;
  site_name: string;
  snippet: string;
  title: string;
  url: string;
}

export interface TinyFishSearchOutput {
  page: number;
  query: string;
  results: TinyFishSearchResult[];
  total_results: number;
}

interface TinyFishRequestOptions {
  signal?: AbortSignal;
}

let tinyFishApiKeyPoolSource: string | undefined;
let tinyFishApiKeyIndex = 0;

export async function fetchTinyFishPages(
  request: TinyFishFetchRequest,
  options: TinyFishRequestOptions = {}
): Promise<TinyFishFetchOutput> {
  const body = await requestTinyFishJson<TinyFishFetchResponse>(
    "fetch",
    (apiKey) =>
      fetch(fetchEndpoint, {
        body: JSON.stringify(request),
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        method: "POST",
        signal: options.signal,
      })
  );

  return sanitizeFetchResponse(body);
}

export async function searchTinyFishWeb(
  request: TinyFishSearchRequest,
  options: TinyFishRequestOptions = {}
): Promise<TinyFishSearchOutput> {
  const url = new URL(searchEndpoint);
  url.searchParams.set("query", request.query);
  url.searchParams.set("location", request.location);
  url.searchParams.set("language", request.language);
  url.searchParams.set("page", String(request.page));

  const body = await requestTinyFishJson<TinyFishSearchResponse>(
    "search",
    (apiKey) =>
      fetch(url.toString(), {
        headers: { "X-API-Key": apiKey },
        method: "GET",
        signal: options.signal,
      })
  );

  return sanitizeSearchResponse(body);
}

function getTinyFishApiKeyAttemptOrder(): string[] {
  const apiKeys = getTinyFishApiKeyPool();
  const startIndex = tinyFishApiKeyIndex % apiKeys.length;
  tinyFishApiKeyIndex = (startIndex + 1) % apiKeys.length;

  return [...apiKeys.slice(startIndex), ...apiKeys.slice(0, startIndex)];
}

function getTinyFishApiKeyPool(): string[] {
  const apiKeyPoolSource = process.env.TINYFISH_API_KEY;

  if (apiKeyPoolSource !== tinyFishApiKeyPoolSource) {
    tinyFishApiKeyPoolSource = apiKeyPoolSource;
    tinyFishApiKeyIndex = 0;
  }

  const apiKeys = tinyFishApiKeyPoolSchema.parse(apiKeyPoolSource);

  if (apiKeys.length === 0) {
    throw new Error(requiredApiKeyError);
  }

  return apiKeys;
}

async function parseTinyFishJsonResponse<T>(
  response: Response,
  serviceName: string
): Promise<T> {
  const bodyText = await response.text();
  const { parseError, value } = parseJsonBody(bodyText);

  if (!response.ok) {
    throw createTinyFishHttpError(response, serviceName, value, parseError);
  }

  if (parseError) {
    throw new Error(`TinyFish returned invalid JSON: ${parseError}`);
  }

  return value as T;
}

async function requestTinyFishJson<T>(
  serviceName: string,
  requestWithApiKey: (apiKey: string) => Promise<Response>
): Promise<T> {
  const apiKeys = getTinyFishApiKeyAttemptOrder();
  let lastRateLimitError: Error | undefined;

  for (const apiKey of apiKeys) {
    const response = await requestWithApiKey(apiKey);

    if (response.status !== 429) {
      return parseTinyFishJsonResponse<T>(response, serviceName);
    }

    lastRateLimitError = await readTinyFishHttpError(response, serviceName);
  }

  if (lastRateLimitError === undefined) {
    throw new Error(requiredApiKeyError);
  }

  if (apiKeys.length === 1) {
    throw lastRateLimitError;
  }

  throw new Error(
    `${lastRateLimitError.message} (all ${apiKeys.length} configured TinyFish API keys returned HTTP 429)`
  );
}

async function readTinyFishHttpError(
  response: Response,
  serviceName: string
): Promise<Error> {
  const bodyText = await response.text();
  const { parseError, value } = parseJsonBody(bodyText);

  return createTinyFishHttpError(response, serviceName, value, parseError);
}

function createTinyFishHttpError(
  response: Response,
  serviceName: string,
  body: unknown,
  parseError?: string
): Error {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMessage = retryAfter ? ` Retry-After: ${retryAfter}.` : "";

  return new Error(
    `TinyFish ${serviceName} request failed with HTTP ${response.status}: ${readErrorMessage(body, parseError)}.${retryAfterMessage}`
  );
}

function sanitizeFetchResponse(
  response: TinyFishFetchResponse
): TinyFishFetchOutput {
  const results = Array.isArray(response.results) ? response.results : [];
  const errors = Array.isArray(response.errors) ? response.errors : [];

  return {
    results: results.map(sanitizeFetchResult),
    errors: errors.map(sanitizeFetchError),
  };
}

function sanitizeFetchResult(value: unknown): TinyFishFetchResult {
  const object = readObject(value);
  assertHasField(object, "text", "fetch results[].text");

  const result: TinyFishFetchResult = {
    final_url: readRequiredString(
      object.final_url,
      "TinyFish fetch results[].final_url"
    ),
    format: readRequiredString(
      object.format,
      "TinyFish fetch results[].format"
    ),
    text: normalizeJsonValue(object.text),
    url: readRequiredString(object.url, "TinyFish fetch results[].url"),
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

function sanitizeFetchError(value: unknown): TinyFishFetchError {
  const object = readObject(value);
  const error: TinyFishFetchError = {
    error: readRequiredString(object.error, "TinyFish fetch errors[].error"),
    url: readRequiredString(object.url, "TinyFish fetch errors[].url"),
  };
  const status = readOptionalNumber(object.status);

  if (status !== undefined) {
    error.status = status;
  }

  return error;
}

function sanitizeSearchResponse(
  response: TinyFishSearchResponse
): TinyFishSearchOutput {
  const results = Array.isArray(response.results) ? response.results : [];

  return {
    page: readRequiredNumber(response.page, "TinyFish search page"),
    query: readRequiredString(response.query, "TinyFish search query"),
    results: results.map(sanitizeSearchResult),
    total_results: readRequiredNumber(
      response.total_results,
      "TinyFish search total_results"
    ),
  };
}

function sanitizeSearchResult(value: unknown): TinyFishSearchResult {
  const object = readObject(value);

  return {
    position: readRequiredNumber(
      object.position,
      "TinyFish search results[].position"
    ),
    site_name: readRequiredString(
      object.site_name,
      "TinyFish search results[].site_name"
    ),
    snippet: readRequiredString(
      object.snippet,
      "TinyFish search results[].snippet"
    ),
    title: readRequiredString(object.title, "TinyFish search results[].title"),
    url: readRequiredString(object.url, "TinyFish search results[].url"),
  };
}

function assertHasField(
  object: Record<string, unknown>,
  key: string,
  fieldName: string
): void {
  if (!Object.hasOwn(object, key)) {
    throw new Error(`Expected TinyFish ${fieldName} to be present.`);
  }
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

function parseJsonBody(bodyText: string): {
  parseError?: string;
  value: unknown;
} {
  if (!bodyText.trim()) {
    return { value: {} };
  }

  try {
    return { value: JSON.parse(bodyText) as unknown };
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
      value: bodyText,
    };
  }
}

function readErrorMessage(body: unknown, parseError?: string): string {
  if (parseError) {
    return `invalid JSON response body: ${parseError}`;
  }

  const error = readObject(readObject(body).error);
  const message = readOptionalString(error.message);

  if (message) {
    return message;
  }

  return JSON.stringify(body);
}
