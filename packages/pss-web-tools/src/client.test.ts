import { describe, expect, it } from "vitest";
import { createWebTools } from "./client.js";

describe("createWebTools", () => {
  it("returns web_search and web_fetch tools", () => {
    const { tools } = createWebTools({ env: {} });

    expect(Object.keys(tools).sort()).toEqual(["web_fetch", "web_search"]);
  });
});