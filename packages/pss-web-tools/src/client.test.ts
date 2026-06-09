import { describe, expect, it } from "vitest";
import { createWebTools } from "./client.js";

describe("createWebTools", () => {
  it("returns web_search and web_fetch tools", () => {
    const { tools } = createWebTools({ env: { EXA_API_KEY: "test-key" } });

    expect(Object.keys(tools).sort()).toEqual(["web_fetch", "web_search"]);
  });
});
