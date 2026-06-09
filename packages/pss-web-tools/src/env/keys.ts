import type { WebToolsBindings } from "./types.js";

export const providerEnvKeys = [
  "TINYFISH_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "FIRECRAWL_API_KEY",
  "PARALLEL_API_KEY",
  "YOU_API_KEY",
  "PERPLEXITY_API_KEY",
  "VALYU_API_KEY",
  "LINKUP_API_KEY",
  "JINA_API_KEY",
  "SERPER_API_KEY",
  "SERPAPI_API_KEY",
  "GOOGLE_CUSTOM_SEARCH_API_KEY",
  "GOOGLE_CUSTOM_SEARCH_ENGINE_ID",
  "BRIGHT_DATA_SERP_API_KEY",
  "BRIGHT_DATA_SERP_ZONE",
  "SCRAPINGBEE_API_KEY",
  "SEARCHAPI_API_KEY",
  "KAGI_API_KEY",
  "KAGI_API_TOKEN",
  "MOJEEK_API_KEY",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "OPENSEARCH_SEARXNG_URLS",
] as const;

export const opensearchFlagEnvKeys = [
  "OPENSEARCH_ENABLE_PARALLEL_MCP",
  "OPENSEARCH_ENABLE_EXA_MCP",
  "OPENSEARCH_ENABLE_ZERO_KEY_PROVIDERS",
] as const;

export const opensearchEndpointEnvKeys = [
  "OPENSEARCH_TAVILY_URL",
  "OPENSEARCH_FIRECRAWL_URL",
  "OPENSEARCH_PARALLEL_URL",
  "OPENSEARCH_YOU_URL",
  "OPENSEARCH_PERPLEXITY_URL",
  "OPENSEARCH_SERPER_URL",
  "OPENSEARCH_SERPAPI_URL",
  "OPENSEARCH_DATAFORSEO_URL",
  "OPENSEARCH_GOOGLE_CSE_URL",
  "OPENSEARCH_KAGI_URL",
  "OPENSEARCH_MOJEEK_URL",
  "OPENSEARCH_BRIGHT_DATA_SERP_URL",
  "OPENSEARCH_SCRAPINGBEE_URL",
  "OPENSEARCH_SEARCHAPI_URL",
  "OPENSEARCH_VALYU_URL",
  "OPENSEARCH_LINKUP_URL",
  "OPENSEARCH_JINA_SEARCH_URL",
  "OPENSEARCH_STARTPAGE_URL",
  "OPENSEARCH_WEBCRAWLER_URL",
  "OPENSEARCH_WIKIPEDIA_URL",
  "OPENSEARCH_INTERNET_ARCHIVE_URL",
  "OPENSEARCH_WIBY_URL",
] as const;

const passthroughEnvKeys = [
  ...providerEnvKeys,
  ...opensearchFlagEnvKeys,
  ...opensearchEndpointEnvKeys,
] as const;

export function pickPassthroughEnv(
  source: WebToolsBindings
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  for (const key of passthroughEnvKeys) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}