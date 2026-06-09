import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardTelegramUpdate } from "./poll-forward";

describe("forwardTelegramUpdate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries until local webhook accepts the update", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("fail", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const forwarded = await forwardTelegramUpdate({
      botToken: "123:abc",
      signal: new AbortController().signal,
      update: { update_id: 7 },
    });

    expect(forwarded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false without acknowledging when all retries fail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("fail", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const forwarded = await forwardTelegramUpdate({
      botToken: "123:abc",
      signal: new AbortController().signal,
      update: { update_id: 9 },
    });

    expect(forwarded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});