import { parseEnvTokenPool } from "../runtime/env";

const fetchEndpoint = "https://api.fetch.tinyfish.ai";
const requiredApiKeyError =
  "TINYFISH_API_KEY is required to use the built-in TinyFish web tools.";
const searchEndpoint = "https://api.search.tinyfish.ai";

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

let tinyFishApiKeyPoolSource: string | undefined;
let tinyFishApiKeyIndex = 0;

export async function fetchTinyFishPages(
  request: TinyFishFetchRequest
): Promise<TinyFishFetchOutput> {
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
}

export async function searchTinyFishWeb(
  request: TinyFishSearchRequest
): Promise<TinyFishSearchOutput> {
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
}

export function getTinyFishApiKey(): string {
  const apiKeyPoolSource = process.env.TINYFISH_API_KEY;

  if (apiKeyPoolSource !== tinyFishApiKeyPoolSource) {
    tinyFishApiKeyPoolSource = apiKeyPoolSource;
    tinyFishApiKeyIndex = 0;
  }

  const apiKeys = parseEnvTokenPool(apiKeyPoolSource);

  if (apiKeys.length === 0) {
    throw new Error(requiredApiKeyError);
  }

  const apiKey = apiKeys[tinyFishApiKeyIndex % apiKeys.length] ?? apiKeys[0];
  tinyFishApiKeyIndex = (tinyFishApiKeyIndex + 1) % apiKeys.length;

  return apiKey;
}

export function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }

  return value.filter((item): item is string => typeof item === "string");
}

async function parseTinyFishJsonResponse<T>(
  response: Response,
  serviceName: string
): Promise<T> {
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);

  if (!response.ok) {
    throw new Error(
      `TinyFish ${serviceName} request failed with HTTP ${response.status}: ${readErrorMessage(body)}`
    );
  }

  return body as T;
}

function sanitizeFetchResponse(
  response: TinyFishFetchResponse
): TinyFishFetchOutput {
  const results = Array.isArray(response.results) ? response.results : [];
  const errors = Array.isArray(response.errors) ? response.errors : [];

  return {
    errors: errors.map(sanitizeFetchError),
    results: results.map(sanitizeFetchResult),
  };
}

function sanitizeFetchResult(value: unknown): TinyFishFetchResult {
  const object = readObject(value);
  const result: TinyFishFetchResult = {
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

function sanitizeFetchError(value: unknown): TinyFishFetchError {
  const object = readObject(value);
  const error: TinyFishFetchError = {
    error: readString(object.error),
    url: readString(object.url),
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
    page: readNumber(response.page),
    query: readString(response.query),
    results: results.map(sanitizeSearchResult),
    total_results: readNumber(response.total_results),
  };
}

function sanitizeSearchResult(value: unknown): TinyFishSearchResult {
  const object = readObject(value);

  return {
    position: readNumber(object.position),
    site_name: readString(object.site_name),
    snippet: readString(object.snippet),
    title: readString(object.title),
    url: readString(object.url),
  };
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

function parseJsonBody(bodyText: string): unknown {
  if (!bodyText.trim()) {
    return {};
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch (error) {
    throw new Error(
      `TinyFish returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readErrorMessage(body: unknown): string {
  const error = readObject(readObject(body).error);
  const message = readOptionalString(error.message);

  if (message) {
    return message;
  }

  return JSON.stringify(body);
}
