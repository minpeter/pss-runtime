export interface WebToolsSearchResult {
  readonly engine: string;
  readonly snippet: string;
  readonly title: string;
  readonly url: string;
}

export interface WebToolsFetchResult {
  readonly content: string;
  readonly length: number;
  readonly title: string;
  readonly url: string;
}

export interface WebToolsFetchOptions {
  readonly maxCharacters?: number;
}

export interface WebToolsClient {
  fetchOne(
    url: string,
    options?: WebToolsFetchOptions
  ): Promise<WebToolsFetchResult>;
  search(
    query: string,
    maxResults?: number
  ): Promise<readonly WebToolsSearchResult[]>;
}
