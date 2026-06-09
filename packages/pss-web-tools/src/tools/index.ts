import type { ToolSet } from "ai";
import type { WebToolsClient } from "../client-types.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";

export function createWebToolSet(client: WebToolsClient): ToolSet {
  return {
    web_fetch: createWebFetchTool(client),
    web_search: createWebSearchTool(client),
  };
}
