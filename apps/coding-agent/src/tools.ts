import {
  createOpenSearch,
  type FetchOptions,
  type FetchResult,
  type OpenSearchEnvironment,
  type OpenSearchOptions,
  type SearchResult,
} from "@minpeter/opensearch/node";
import type { ToolSet } from "ai";

import {
  CodingAgentToolsConfigError,
  CodingAgentWebToolsUnavailableError,
  TINYFISH_API_KEY_ENV,
} from "./tools-errors";
import { createWebFetchTool, type WebFetchTool } from "./tools-web-fetch";
import { createWebSearchTool, type WebSearchTool } from "./tools-web-search";

export {
  CodingAgentToolAbortError,
  CodingAgentToolsConfigError,
  CodingAgentWebToolsUnavailableError,
} from "./tools-errors";
export type { WebFetchInput } from "./tools-web-fetch";
export type { WebSearchInput } from "./tools-web-search";

export const WEB_TOOLS_DISABLED_MESSAGE = `web tools disabled: missing ${TINYFISH_API_KEY_ENV}`;

/**
 * Availability mode for the provider-backed web tools:
 *
 * - `required`: fail fast during tool/agent initialization when the provider
 *   configuration (TINYFISH_API_KEY) is missing.
 * - `optional` (default): omit the web tools when the provider configuration
 *   is missing and report the omission through `onWebToolsDisabled`
 *   (default: `console.warn`).
 * - `disabled`: never register the web tools.
 */
export type WebToolsAvailability = "disabled" | "optional" | "required";

export interface CodingAgentOpenSearchClient {
  fetch(
    urls: readonly string[],
    options?: FetchOptions
  ): Promise<readonly FetchResult[]>;
  search(query: string, maxResults?: number): Promise<readonly SearchResult[]>;
}

export interface CreateCodingAgentToolsOptions {
  readonly client?: CodingAgentOpenSearchClient;
  readonly onWebToolsDisabled?: (message: string) => void;
  readonly openSearchOptions?: OpenSearchOptions;
  readonly webToolsAvailability?: WebToolsAvailability;
}

export interface CodingAgentToolSet extends ToolSet {
  readonly web_fetch: WebFetchTool;
  readonly web_search: WebSearchTool;
}

/**
 * Create the provider-backed web tools, gated on TINYFISH_API_KEY before the
 * OpenSearch client is wired. An injected `client` counts as provider
 * configuration in `optional` and `required` modes; `disabled` always returns
 * an empty tool set. Defaults to `optional`, so startup succeeds without a
 * key and the omission is reported instead of advertising tools that can only
 * fail at execution time.
 */
export function createCodingAgentTools(
  options: CreateCodingAgentToolsOptions & {
    readonly client: CodingAgentOpenSearchClient;
    readonly webToolsAvailability?: "optional" | "required";
  }
): CodingAgentToolSet;
export function createCodingAgentTools(
  options?: CreateCodingAgentToolsOptions
): ToolSet;
export function createCodingAgentTools(
  options: CreateCodingAgentToolsOptions = {}
): ToolSet {
  const availability = options.webToolsAvailability ?? "optional";
  if (availability === "disabled") {
    return {};
  }

  if (
    options.client === undefined &&
    !hasTinyFishApiKey(options.openSearchOptions?.env ?? process.env)
  ) {
    if (availability === "required") {
      throw new CodingAgentWebToolsUnavailableError();
    }

    (options.onWebToolsDisabled ?? console.warn)(WEB_TOOLS_DISABLED_MESSAGE);
    return {};
  }

  const client = resolveOpenSearchClient(options);
  return {
    web_search: createWebSearchTool(client),
    web_fetch: createWebFetchTool(client),
  };
}

export function resolveStartTuiTools(
  tools?: ToolSet,
  options?: CreateCodingAgentToolsOptions
): ToolSet {
  return tools ?? createCodingAgentTools(options);
}

function hasTinyFishApiKey(env: OpenSearchEnvironment): boolean {
  return (env[TINYFISH_API_KEY_ENV] ?? "")
    .split(";")
    .some((apiKey) => apiKey.trim().length > 0);
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
