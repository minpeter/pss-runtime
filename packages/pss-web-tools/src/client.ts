import { createOpenSearch, type OpenSearchClient } from "@minpeter/opensearch";
import type { ToolSet } from "ai";
import type { WebToolsEnvironment } from "./env/types.js";
import { createWebToolSet } from "./tools/index.js";

export interface CreateWebToolsOptions {
  readonly env: WebToolsEnvironment;
  readonly client?: OpenSearchClient;
}

export interface WebToolsBundle {
  readonly client: OpenSearchClient;
  readonly tools: ToolSet;
}

export function createWebTools(options: CreateWebToolsOptions): WebToolsBundle {
  const client = options.client ?? createOpenSearch({ env: options.env });
  return {
    client,
    tools: createWebToolSet(client),
  };
}