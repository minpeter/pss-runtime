import { z } from "zod";

import type { WorkerAgentToolSet } from "./tools";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_FETCH_TOOL_NAME = "web_fetch";

const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";
const DEFAULT_JINA_READER_BASE_URL = "https://r.jina.ai";
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_MARKDOWN_CHARS = 12_000;
const TRAILING_SLASH_PATTERN = /\/$/u;
const SCRIPT_TAG_PATTERN = /<script[\s\S]*?<\/script>/giu;
const STYLE_TAG_PATTERN = /<style[\s\S]*?<\/style>/giu;
const HTML_TAG_PATTERN = /<[^>]+>/gu;
const MULTI_SPACE_PATTERN = /\s+/gu;

const WebSearchInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Maximum number of results to return (default 5)."),
    query: z
      .string()
      .min(1)
      .describe("Web search query for current facts, news, docs, or links."),
  })
  .strict();

const WebFetchInputSchema = z
  .object({
    url: z
      .string()
      .url()
      .describe("HTTP(S) URL to fetch as readable markdown/text."),
  })
  .strict();

export interface WebSearchResultItem {
  readonly description: string | null;
  readonly title: string | null;
  readonly url: string;
}

export interface WebSearchToolResult {
  readonly provider: "firecrawl";
  readonly query: string;
  readonly results: readonly WebSearchResultItem[];
}

export interface WebFetchToolResult {
  readonly markdown: string;
  readonly provider: "firecrawl" | "jina" | "direct";
  readonly title: string | null;
  readonly url: string;
}

export interface WebToolsOptions {
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional Firecrawl API key. Search/scrape work keyless on Firecrawl's free
   * tier; a key only raises limits / attribution for a personal account.
   */
  readonly firecrawlApiKey?: string;
  readonly firecrawlBaseUrl?: string;
  readonly jinaReaderBaseUrl?: string;
}

export class WebToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebToolError";
  }
}

export function createWebTools(
  options: WebToolsOptions = {}
): WorkerAgentToolSet {
  const fetchImpl = options.fetchImpl ?? fetch;
  const firecrawlBaseUrl =
    options.firecrawlBaseUrl?.trim() || DEFAULT_FIRECRAWL_BASE_URL;
  const jinaReaderBaseUrl =
    options.jinaReaderBaseUrl?.trim() || DEFAULT_JINA_READER_BASE_URL;
  const apiKey = options.firecrawlApiKey?.trim();

  return {
    [WEB_SEARCH_TOOL_NAME]: {
      description:
        "Search the public web / 웹 검색 / 인터넷 검색 / 뉴스 검색 for current information, news, docs, or links via Firecrawl (keyless free tier). Use when the user says 검색해줘, 찾아줘, look up, google, or asks for live facts not in chat. Prefer web_fetch after picking a concrete URL.",
      execute: async (input: unknown): Promise<WebSearchToolResult> => {
        const parsed = WebSearchInputSchema.parse(input);
        const query = parsed.query.trim();
        const limit = parsed.limit ?? DEFAULT_SEARCH_LIMIT;
        const results = await firecrawlSearch({
          apiKey,
          baseUrl: firecrawlBaseUrl,
          fetchImpl,
          limit,
          query,
        });
        return {
          provider: "firecrawl",
          query,
          results,
        };
      },
      inputSchema: WebSearchInputSchema,
    },
    [WEB_FETCH_TOOL_NAME]: {
      description:
        "Fetch / scrape / 페이지 읽기 / 링크 열기 for a specific web page as readable markdown/text. Use after web_search or when the user provides a URL (http/https). Tries Firecrawl scrape, then free Jina Reader, then a plain GET.",
      execute: async (input: unknown): Promise<WebFetchToolResult> => {
        const parsed = WebFetchInputSchema.parse(input);
        const url = parsed.url.trim();
        assertHttpUrl(url);
        return await fetchPageMarkdown({
          apiKey,
          fetchImpl,
          firecrawlBaseUrl,
          jinaReaderBaseUrl,
          url,
        });
      },
      inputSchema: WebFetchInputSchema,
    },
  };
}

async function firecrawlSearch(options: {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly limit: number;
  readonly query: string;
}): Promise<WebSearchResultItem[]> {
  const response = await options.fetchImpl(`${options.baseUrl}/search`, {
    body: JSON.stringify({
      limit: options.limit,
      query: options.query,
    }),
    headers: firecrawlHeaders(options.apiKey),
    method: "POST",
  });
  if (!response.ok) {
    const detail = await safeErrorBody(response);
    throw new WebToolError(
      `Firecrawl search failed (${response.status})${detail ? `: ${detail}` : ""}. Free keyless tier may be rate-limited; optional FIRECRAWL_API_KEY raises limits.`
    );
  }
  const body = (await response.json()) as {
    readonly data?: {
      readonly web?: readonly {
        readonly description?: string;
        readonly title?: string;
        readonly url?: string;
      }[];
    };
    // older shapes
    readonly web?: readonly {
      readonly description?: string;
      readonly title?: string;
      readonly url?: string;
    }[];
  };
  const rows = body.data?.web ?? body.web ?? [];
  return rows
    .filter(
      (row): row is { url: string; title?: string; description?: string } =>
        Boolean(row.url)
    )
    .map((row) => ({
      description: row.description ?? null,
      title: row.title ?? null,
      url: row.url,
    }));
}

async function fetchPageMarkdown(options: {
  readonly apiKey: string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly firecrawlBaseUrl: string;
  readonly jinaReaderBaseUrl: string;
  readonly url: string;
}): Promise<WebFetchToolResult> {
  try {
    return await firecrawlScrape(options);
  } catch {
    // fall through
  }
  try {
    return await jinaFetch(options);
  } catch {
    // fall through
  }
  return await directFetch(options);
}

async function firecrawlScrape(options: {
  readonly apiKey: string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly firecrawlBaseUrl: string;
  readonly url: string;
}): Promise<WebFetchToolResult> {
  const response = await options.fetchImpl(
    `${options.firecrawlBaseUrl}/scrape`,
    {
      body: JSON.stringify({
        formats: [{ type: "markdown" }],
        onlyMainContent: true,
        url: options.url,
      }),
      headers: firecrawlHeaders(options.apiKey),
      method: "POST",
    }
  );
  if (!response.ok) {
    throw new WebToolError(`Firecrawl scrape failed (${response.status}).`);
  }
  const body = (await response.json()) as {
    readonly data?: {
      readonly markdown?: string;
      readonly metadata?: { readonly title?: string };
    };
  };
  const markdown = truncateMarkdown(body.data?.markdown ?? "");
  if (!markdown) {
    throw new WebToolError("Firecrawl scrape returned empty markdown.");
  }
  return {
    markdown,
    provider: "firecrawl",
    title: body.data?.metadata?.title ?? null,
    url: options.url,
  };
}

async function jinaFetch(options: {
  readonly fetchImpl: typeof fetch;
  readonly jinaReaderBaseUrl: string;
  readonly url: string;
}): Promise<WebFetchToolResult> {
  const response = await options.fetchImpl(
    `${options.jinaReaderBaseUrl.replace(TRAILING_SLASH_PATTERN, "")}/${options.url}`,
    {
      headers: {
        accept: "text/plain",
        "x-return-format": "markdown",
      },
    }
  );
  if (!response.ok) {
    throw new WebToolError(`Jina Reader failed (${response.status}).`);
  }
  const markdown = truncateMarkdown(await response.text());
  if (!markdown.trim()) {
    throw new WebToolError("Jina Reader returned empty content.");
  }
  return {
    markdown,
    provider: "jina",
    title: null,
    url: options.url,
  };
}

async function directFetch(options: {
  readonly fetchImpl: typeof fetch;
  readonly url: string;
}): Promise<WebFetchToolResult> {
  const response = await options.fetchImpl(options.url, {
    headers: {
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      "user-agent":
        "pss-worker-agent/1.0 (+https://github.com/minpeter/pss-runtime)",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new WebToolError(
      `Direct fetch failed (${response.status}) for ${options.url}.`
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  const markdown = truncateMarkdown(
    contentType.includes("html") ? stripHtmlToText(raw) : raw
  );
  if (!markdown.trim()) {
    throw new WebToolError("Direct fetch returned empty content.");
  }
  return {
    markdown,
    provider: "direct",
    title: null,
    url: options.url,
  };
}

function firecrawlHeaders(apiKey: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebToolError("web_fetch.url must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebToolError("web_fetch only supports http(s) URLs.");
  }
}

function truncateMarkdown(value: string): string {
  if (value.length <= MAX_MARKDOWN_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_MARKDOWN_CHARS)}\n\n…[truncated]`;
}

function stripHtmlToText(html: string): string {
  return html
    .replace(SCRIPT_TAG_PATTERN, " ")
    .replace(STYLE_TAG_PATTERN, " ")
    .replace(HTML_TAG_PATTERN, " ")
    .replace(MULTI_SPACE_PATTERN, " ")
    .trim();
}

async function safeErrorBody(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.slice(0, 200) || undefined;
  } catch {
    return;
  }
}
