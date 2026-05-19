import type { ToolSet } from "ai";
import { webFetchTool as defaultWebFetchTool } from "./web-fetch";
import { webSearchTool as defaultWebSearchTool } from "./web-search";

export type AgentTools = ToolSet;

export const tools = {
  web_fetch: defaultWebFetchTool,
  web_search: defaultWebSearchTool,
} satisfies AgentTools;

export type DefaultTools = typeof tools;
