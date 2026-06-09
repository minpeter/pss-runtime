import { describe, expect, it, vi } from "vitest";
import { createExaClient } from "./client.js";

function createFetchMock(
  handler: (url: string, init?: RequestInit) => unknown
): typeof fetch {
  return vi.fn((input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const payload = handler(url, init);
    return Promise.resolve({
      json: async () => payload,
      ok: true,
      status: 200,
    } as Response);
  });
}

describe("createExaClient", () => {
  it("searches with Exa and maps highlights to snippets", async () => {
    const fetchImpl = createFetchMock((url, init) => {
      expect(url).toBe("https://api.exa.ai/search");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
        "x-api-key": "test-exa-key",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        contents: { highlights: true },
        numResults: 3,
        query: "hashed vc",
        type: "auto",
      });

      return {
        results: [
          {
            highlights: ["Selective disclosure for VCs."],
            title: "SD-JWT VC",
            url: "https://example.com/sd-jwt",
          },
        ],
      };
    });
    const client = createExaClient({
      apiKey: "test-exa-key",
      fetchImpl,
    });

    await expect(client.search("hashed vc", 3)).resolves.toEqual([
      {
        engine: "web",
        snippet: "Selective disclosure for VCs.",
        title: "SD-JWT VC",
        url: "https://example.com/sd-jwt",
      },
    ]);
  });

  it("fetches page contents through Exa contents API", async () => {
    const fetchImpl = createFetchMock((url, init) => {
      expect(url).toBe("https://api.exa.ai/contents");
      expect(JSON.parse(String(init?.body))).toEqual({
        text: { maxCharacters: 12_000 },
        urls: ["https://example.com/page"],
      });

      return {
        results: [
          {
            text: "# Page body",
            title: "Example page",
            url: "https://example.com/page",
          },
        ],
        statuses: [
          {
            id: "https://example.com/page",
            status: "success",
          },
        ],
      };
    });
    const client = createExaClient({
      apiKey: "test-exa-key",
      fetchImpl,
    });

    await expect(client.fetchOne("https://example.com/page")).resolves.toEqual({
      content: "# Page body",
      length: 11,
      title: "Example page",
      url: "https://example.com/page",
    });
  });
});
