import { describe, expect, it } from "vitest";
import { tools } from ".";

describe("tools", () => {
  it("exports web tools through the shared tools map", () => {
    expect(Object.keys(tools).sort()).toEqual(["web_fetch", "web_search"]);
    expect(tools.web_search).toBeDefined();
    expect(tools.web_fetch).toBeDefined();
    expect("continue" in tools).toBe(false);
  });
});