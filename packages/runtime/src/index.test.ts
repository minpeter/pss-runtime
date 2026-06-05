import { describe, expect, it } from "vitest";

describe("runtime public exports", () => {
  it("does not expose internal agent loop runner from package root", async () => {
    const runtime = await import("./index");

    expect(runtime).not.toHaveProperty("runAgentLoop");
  });

  it("does not expose event fanout helpers from package root", async () => {
    const runtime = await import("./index");

    expect(runtime).not.toHaveProperty("consumeRunEvents");
  });

  it("exposes plugin factories from the plugins module", async () => {
    const plugins = await import("./plugins");

    expect(plugins).toEqual(
      expect.objectContaining({
        compaction: expect.any(Function),
        definePlugin: expect.any(Function),
        memory: expect.any(Function),
        sessions: expect.objectContaining({
          custom: expect.any(Function),
          file: expect.any(Function),
          inMemory: expect.any(Function),
        }),
      })
    );
  });
});
