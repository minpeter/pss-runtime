import { describe, expect, it, vi } from "vitest";
import type { OpenSearchClient } from "@minpeter/opensearch";
import { createWebFetchTool } from "./web-fetch.js";

interface ExecutableTool {
  execute: (
    input: unknown,
    options?: { abortSignal?: AbortSignal }
  ) => Promise<unknown>;
}

const executeTool = (tool: unknown, input: unknown) =>
  (tool as ExecutableTool).execute(input);

describe("createWebFetchTool", () => {
  it("returns partial success with per-URL errors", async () => {
    const fetch = vi
      .fn<OpenSearchClient["fetch"]>()
      .mockImplementation(async (input) => {
        if (typeof input !== "string") {
          throw new Error("expected single-url fetch");
        }

        if (input === "https://bad.example") {
          throw new Error("upstream unavailable");
        }

        return {
          url: input,
          title: "Good page",
          content: "# Hello",
          length: 7,
        };
      });
    const client = { search: vi.fn(), fetch } satisfies OpenSearchClient;
    const tool = createWebFetchTool(client);

    await expect(
      executeTool(tool, {
        urls: ["https://good.example", "https://bad.example"],
      })
    ).resolves.toEqual({
      results: [
        {
          url: "https://good.example",
          title: "Good page",
          content: "# Hello",
          length: 7,
        },
      ],
      errors: [
        {
          url: "https://bad.example",
          error: "upstream unavailable",
        },
      ],
    });
  });

  it("rejects invalid protocols before calling the client", async () => {
    const fetch = vi.fn<OpenSearchClient["fetch"]>();
    const client = { search: vi.fn(), fetch } satisfies OpenSearchClient;
    const tool = createWebFetchTool(client);

    await expect(
      executeTool(tool, { urls: ["ftp://example.com/file"] })
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});