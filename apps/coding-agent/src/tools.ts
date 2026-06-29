import {
  createOpenSearch,
  type FetchOptions,
  type FetchResult,
  type OpenSearchOptions,
  type SearchResult,
} from "@minpeter/opensearch/node";
import { jsonSchema, type Tool, type ToolSet, tool } from "ai";

const DEFAULT_SEARCH_RESULT_COUNT = 5;
const MAX_FETCH_URLS = 10;
const MAX_SEARCH_RESULTS = 15;

type CodingAgentToolName = "web_fetch" | "web_search";

export interface CodingAgentOpenSearchClient {
  fetch(
    urls: readonly string[],
    options?: FetchOptions
  ): Promise<readonly FetchResult[]>;
  search(query: string, maxResults?: number): Promise<readonly SearchResult[]>;
}

export interface CreateCodingAgentToolsOptions {
  readonly client?: CodingAgentOpenSearchClient;
  readonly openSearchOptions?: OpenSearchOptions;
}

export interface WebSearchInput {
  readonly numResults?: number;
  readonly query: string;
}

export interface WebFetchInput {
  readonly maxCharacters?: number;
  readonly urls: readonly string[];
}

export interface CodingAgentToolSet extends ToolSet {
  readonly web_fetch: Tool<
    WebFetchInput,
    readonly FetchResult[],
    Record<string, unknown>
  >;
  readonly web_search: Tool<
    WebSearchInput,
    readonly SearchResult[],
    Record<string, unknown>
  >;
}

export class CodingAgentToolsConfigError extends Error {
  readonly code = "client-open-search-options-conflict";

  constructor() {
    super("Provide either client or openSearchOptions, not both.");
    this.name = "CodingAgentToolsConfigError";
  }
}

export class CodingAgentToolAbortError extends Error {
  readonly reason: unknown;
  readonly toolName: CodingAgentToolName;

  constructor(toolName: CodingAgentToolName, reason: unknown) {
    super(`${toolName} aborted.`);
    this.name = "CodingAgentToolAbortError";
    this.reason = reason;
    this.toolName = toolName;
  }
}

export function createCodingAgentTools(
  options: CreateCodingAgentToolsOptions = {}
): CodingAgentToolSet {
  const client = resolveOpenSearchClient(options);
  return {
    web_search: createWebSearchTool(client),
    web_fetch: createWebFetchTool(client),
  };
}

export function resolveStartTuiTools(tools?: ToolSet): ToolSet {
  return tools ?? createCodingAgentTools();
}

function resolveOpenSearchClient({
  client,
  openSearchOptions,
}: CreateCodingAgentToolsOptions): CodingAgentOpenSearchClient {
  if (client !== undefined && openSearchOptions !== undefined) {
    throw new CodingAgentToolsConfigError();
  }

  return client ?? createOpenSearch(openSearchOptions);
}

function createWebSearchTool(
  client: Pick<CodingAgentOpenSearchClient, "search">
): CodingAgentToolSet["web_search"] {
  return tool<WebSearchInput, readonly SearchResult[], Record<string, unknown>>(
    {
      description:
        "Search the web for current facts, documentation, news, people, companies, and other external information. Follow promising URLs with web_fetch when full page content is needed.",
      execute: async (input, options) => {
        abortIfRequested(options.abortSignal, "web_search");
        return await client.search(
          input.query,
          input.numResults ?? DEFAULT_SEARCH_RESULT_COUNT
        );
      },
      inputSchema: jsonSchema<WebSearchInput>({
        additionalProperties: false,
        properties: {
          numResults: {
            description:
              "Optional result count from 1 to 15. Defaults to 5 when omitted.",
            maximum: MAX_SEARCH_RESULTS,
            minimum: 1,
            type: "integer",
          },
          query: {
            description:
              "Non-empty natural-language search query. Search operators such as site:example.com may be included.",
            minLength: 1,
            type: "string",
          },
        },
        required: ["query"],
        type: "object",
      }),
      outputSchema: jsonSchema<readonly SearchResult[]>({
        items: {
          additionalProperties: false,
          properties: {
            engine: { type: "string" },
            snippet: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
          },
          required: ["engine", "snippet", "title", "url"],
          type: "object",
        },
        type: "array",
      }),
    }
  );
}

function createWebFetchTool(
  client: Pick<CodingAgentOpenSearchClient, "fetch">
): CodingAgentToolSet["web_fetch"] {
  return tool<WebFetchInput, readonly FetchResult[], Record<string, unknown>>({
    description:
      "Read one or more webpages as clean markdown with source metadata. Use after web_search when a result needs full-page content, or call directly with known URLs.",
    execute: async (input, options) => {
      abortIfRequested(options.abortSignal, "web_fetch");
      return await client.fetch(input.urls, getFetchOptions(input));
    },
    inputSchema: jsonSchema<WebFetchInput>({
      additionalProperties: false,
      properties: {
        maxCharacters: {
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
          maxItems: MAX_FETCH_URLS,
          minItems: 1,
          type: "array",
        },
      },
      required: ["urls"],
      type: "object",
    }),
    outputSchema: jsonSchema<readonly FetchResult[]>({
      items: {
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          length: { type: "number" },
          title: { type: "string" },
          url: { type: "string" },
        },
        required: ["content", "length", "title", "url"],
        type: "object",
      },
      type: "array",
    }),
  });
}

function getFetchOptions(input: WebFetchInput): FetchOptions | undefined {
  if (input.maxCharacters === undefined) {
    return;
  }

  return { maxCharacters: input.maxCharacters };
}

function abortIfRequested(
  signal: AbortSignal | undefined,
  toolName: CodingAgentToolName
): void {
  if (signal === undefined || !signal.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  throw new CodingAgentToolAbortError(toolName, signal.reason);
}
