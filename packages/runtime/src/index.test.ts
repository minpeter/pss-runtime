import { describe, expect, it } from "vitest";
import * as runtime from "./index";

describe("runtime public exports", () => {
  it("does not expose internal agent loop runner from package root", () => {
    expect(runtime).not.toHaveProperty("runAgentLoop");
  });
});
