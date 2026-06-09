import type { ToolSet } from "ai";
import type { OpenSearchClient } from "@minpeter/opensearch";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";

export function createWebToolSet(client: OpenSearchClient): ToolSet {
  return {
    web_fetch: createWebFetchTool(client),
    web_search: createWebSearchTool(client),
  };
}

export { createWebFetchTool, parseWebFetchOutput } from "./web-fetch.js";
export { createWebSearchTool, parseWebSearchOutput } from "./web-search.js";