import { describe, expect, it, vi } from "vitest";

import { resolveFetchImpl } from "./fetch-impl";

describe("resolveFetchImpl", () => {
  it("returns an injected fetch implementation unchanged", () => {
    const injected = vi.fn() as unknown as typeof fetch;
    expect(resolveFetchImpl(injected)).toBe(injected);
  });

  it("defaults to a wrapper that calls globalThis.fetch (Workers-safe)", async () => {
    const response = new Response("ok", { status: 200 });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response);

    const fetchImpl = resolveFetchImpl();
    const result = await fetchImpl("https://example.com/search", {
      method: "POST",
    });

    expect(result).toBe(response);
    expect(spy).toHaveBeenCalledWith(
      "https://example.com/search",
      expect.objectContaining({ method: "POST" })
    );
    spy.mockRestore();
  });
});
