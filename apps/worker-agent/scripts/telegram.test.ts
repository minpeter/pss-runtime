import { describe, expect, it, vi } from "vitest";

import { logError } from "../src/worker-log";
import { forwardUpdates, isAbortError, sleepMs } from "./telegram";

vi.mock("../src/worker-log", () => ({
  logError: vi.fn(),
  logTagged: vi.fn(),
}));

describe("telegram local relay", () => {
  it("treats AbortError as a clean shutdown signal", () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    expect(isAbortError(abortError)).toBe(true);
    expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
  });

  it("sleepMs resolves early when aborted", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const sleeping = sleepMs(30_000, abort.signal);
    abort.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not advance offset past a failed forwarded update", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      forwardUpdates({
        offset: 0,
        secret: "secret",
        signal: new AbortController().signal,
        updates: [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }],
        webhookUrl: "http://127.0.0.1:8792/",
      })
    ).resolves.toBe(11);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith({
      action: "webhook_forward_status",
      scope: "telegram-relay",
      status: 500,
    });
  });

  it("does not advance offset past a thrown forward failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      forwardUpdates({
        offset: 0,
        secret: "secret",
        signal: new AbortController().signal,
        updates: [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }],
        webhookUrl: "http://127.0.0.1:8792/",
      })
    ).resolves.toBe(11);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(expect.any(TypeError), {
      action: "webhook_forward_failed",
      scope: "telegram-relay",
    });
  });
});
