import type {
  WebToolsClient,
  WebToolsFetchOptions,
  WebToolsFetchResult,
  WebToolsSearchResult,
} from "../client-types.js";
import { defaultFetchMaxCharacters } from "../schemas/web-fetch.js";

const exaApiBaseUrl = "https://api.exa.ai";
const webSearchSource = "web";

interface ExaSearchResponse {
  readonly results?: readonly ExaContentResult[];
}

interface ExaContentsResponse {
  readonly results?: readonly ExaContentResult[];
  readonly statuses?: readonly {
    readonly error?: { readonly tag?: string };
    readonly id: string;
    readonly status: "error" | "success";
  }[];
}

interface ExaContentResult {
  readonly highlights?: readonly string[];
  readonly summary?: string;
  readonly text?: string;
  readonly title?: string;
  readonly url: string;
}

export interface CreateExaClientOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

export class ExaApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ExaApiError";
    this.status = status;
  }
}

export function createExaClient(
  options: CreateExaClientOptions
): WebToolsClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async fetchOne(url: string, fetchOptions?: WebToolsFetchOptions) {
      const [result] = await fetchUrls(
        fetchImpl,
        options.apiKey,
        [url],
        fetchOptions
      );
      if (!result) {
        throw new Error(`web_fetch returned no content for ${url}.`);
      }
      return result;
    },
    async search(
      query: string,
      maxResults = 5
    ): Promise<readonly WebToolsSearchResult[]> {
      const response = await postExa<ExaSearchResponse>(
        fetchImpl,
        options.apiKey,
        "/search",
        {
          contents: {
            highlights: true,
          },
          numResults: maxResults,
          query,
          type: "auto",
        }
      );

      return (response.results ?? []).map((result) => ({
        engine: webSearchSource,
        snippet: readSnippet(result),
        title: result.title?.trim() || result.url,
        url: result.url,
      }));
    },
  };
}

async function fetchUrls(
  fetchImpl: typeof fetch,
  apiKey: string,
  urls: readonly string[],
  fetchOptions?: WebToolsFetchOptions
): Promise<readonly WebToolsFetchResult[]> {
  const maxCharacters =
    fetchOptions?.maxCharacters ?? defaultFetchMaxCharacters;
  const response = await postExa<ExaContentsResponse>(
    fetchImpl,
    apiKey,
    "/contents",
    {
      text: {
        maxCharacters,
      },
      urls: [...urls],
    }
  );
  const resultsByUrl = new Map(
    (response.results ?? []).map((result) => [result.url, result] as const)
  );

  return urls.map((url) => {
    const status = response.statuses?.find((entry) => entry.id === url);
    if (status?.status === "error") {
      throw new Error(status.error?.tag ?? `Exa contents failed for ${url}.`);
    }

    const result = resultsByUrl.get(url);
    if (!result) {
      throw new Error(`Exa contents returned no result for ${url}.`);
    }

    const content = result.text?.trim() ?? "";
    return {
      content,
      length: content.length,
      title: result.title?.trim() || url,
      url,
    };
  });
}

function readSnippet(result: ExaContentResult): string {
  const highlights =
    result.highlights?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (highlights.length > 0) {
    return highlights.join(" ");
  }

  const summary = result.summary?.trim();
  if (summary) {
    return summary;
  }

  const text = result.text?.trim();
  if (!text) {
    return "";
  }

  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

async function postExa<TResponse>(
  fetchImpl: typeof fetch,
  apiKey: string,
  path: string,
  body: Record<string, unknown>
): Promise<TResponse> {
  const response = await fetchImpl(`${exaApiBaseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    method: "POST",
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExaApiError(
      `Failed to parse Exa response for ${path}.`,
      response.status
    );
  }

  if (!response.ok) {
    const description =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Exa ${path} failed with status ${response.status}.`;
    throw new ExaApiError(description, response.status);
  }

  return payload as TResponse;
}
