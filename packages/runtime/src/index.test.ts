import { describe, expect, it } from "vitest";

describe("runtime public exports", () => {
  it("does not expose internal agent loop runner from package root", async () => {
    const runtime = await import("./index");

    expect(runtime).not.toHaveProperty("runAgentLoop");
  });
});
