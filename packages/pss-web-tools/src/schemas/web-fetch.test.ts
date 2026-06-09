import { describe, expect, it } from "vitest";
import { webFetchInputSchema } from "./web-fetch.js";

describe("webFetch schemas", () => {
  it("rejects more than 10 URLs", () => {
    const urls = Array.from(
      { length: 11 },
      (_, index) => `https://example.com/${index}`
    );

    expect(() => webFetchInputSchema.parse({ urls })).toThrow();
  });

  it("rejects non-http URLs", () => {
    expect(() =>
      webFetchInputSchema.parse({ urls: ["ftp://example.com/file"] })
    ).toThrow();
  });
});