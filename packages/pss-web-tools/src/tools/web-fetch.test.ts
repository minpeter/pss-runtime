import { describe, expect, it, vi } from "vitest";
import type { WebToolsClient } from "../client-types.js";
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
    const fetchOne = vi
      .fn<WebToolsClient["fetchOne"]>()
      .mockImplementation((url) => {
        if (url === "https://bad.example") {
          return Promise.reject(new Error("upstream unavailable"));
        }

        return Promise.resolve({
          url,
          title: "Good page",
          content: "# Hello",
          length: 7,
        });
      });
    const client = { search: vi.fn(), fetchOne } satisfies WebToolsClient;
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
    const fetchOne = vi.fn<WebToolsClient["fetchOne"]>();
    const client = { search: vi.fn(), fetchOne } satisfies WebToolsClient;
    const tool = createWebFetchTool(client);

    await expect(
      executeTool(tool, { urls: ["ftp://example.com/file"] })
    ).rejects.toThrow();
    expect(fetchOne).not.toHaveBeenCalled();
  });
});
