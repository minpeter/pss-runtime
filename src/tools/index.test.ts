import { describe, expect, it } from "vitest";
import { tools } from ".";
import { continueTool } from "./continue";

describe("tools", () => {
  it("exports the continue tool through the shared tools map", () => {
    expect(tools.continue).toBe(continueTool);
  });
});
