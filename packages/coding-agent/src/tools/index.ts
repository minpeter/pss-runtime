import type { AgentTools } from "@minpeter/pss-runtime";
import { webFetchTool as defaultWebFetchTool } from "./web-fetch";
import { webSearchTool as defaultWebSearchTool } from "./web-search";

export const tools: AgentTools = {
  web_fetch: defaultWebFetchTool,
  web_search: defaultWebSearchTool,
};

export type DefaultTools = typeof tools;
