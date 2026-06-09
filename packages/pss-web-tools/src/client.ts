import type { ToolSet } from "ai";
import type { WebToolsClient } from "./client-types.js";
import { resolveExaApiKey } from "./env/exa.js";
import type { WebToolsEnvironment } from "./env/types.js";
import { createExaClient } from "./exa/client.js";
import { createWebToolSet } from "./tools/index.js";

export interface CreateWebToolsOptions {
  readonly client?: WebToolsClient;
  readonly env: WebToolsEnvironment;
}

export interface WebToolsBundle {
  readonly client: WebToolsClient;
  readonly tools: ToolSet;
}

export function createWebTools(options: CreateWebToolsOptions): WebToolsBundle {
  const client =
    options.client ??
    createExaClient({
      apiKey: resolveExaApiKey(options.env),
    });

  return {
    client,
    tools: createWebToolSet(client),
  };
}
