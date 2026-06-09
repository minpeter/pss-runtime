import type { WebToolsEnvironment } from "./types.js";

export class MissingExaApiKeyError extends Error {
  constructor() {
    super("EXA_API_KEY is required for web_search and web_fetch.");
    this.name = "MissingExaApiKeyError";
  }
}

export function resolveExaApiKey(env: WebToolsEnvironment): string {
  const configured = env.EXA_API_KEY?.trim();
  if (!configured) {
    throw new MissingExaApiKeyError();
  }

  return configured;
}
