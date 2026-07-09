import { afterEach, describe, expect, it, vi } from "vitest";

import { logError } from "../src/worker-log";
import { forwardUpdates, isAbortError, sleepMs } from "./telegram";

vi.mock("../src/worker-log", () => ({
  logError: vi.fn(),
  logTagged: vi.fn(),
}));

/** Relay calls fetch(url, { body: JSON.stringify(update), ... }). */
function updateIdFromFetchArgs(
  input: RequestInfo | URL,
  init?: RequestInit
): number {
  if (typeof init?.body === "string") {
    return (JSON.parse(init.body) as { update_id: number }).update_id;
  }
  if (input instanceof Request) {
    throw new Error("Expected fetch(url, init) with string body in relay");
  }
  throw new Error("Missing fetch body with update_id");
}

describe("telegram local relay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

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

  it("forwards a getUpdates batch in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const done = forwardUpdates({
      offset: 0,
      secret: "secret",
      signal: new AbortController().signal,
      updates: [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }],
      webhookUrl: "http://127.0.0.1:8792/",
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(maxInFlight).toBe(3);
    });
    release();
    await expect(done).resolves.toBe(13);
  });

  it("does not advance offset past the first failed update in id order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const updateId = updateIdFromFetchArgs(input, init);
        return new Response(null, {
          status: updateId === 11 ? 500 : 200,
        });
      })
    );

    await expect(
      forwardUpdates({
        offset: 0,
        secret: "secret",
        signal: new AbortController().signal,
        updates: [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }],
        webhookUrl: "http://127.0.0.1:8792/",
      })
    ).resolves.toBe(11);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledWith({
      action: "webhook_forward_status",
      scope: "telegram-relay",
      status: 500,
      updateId: 11,
    });
  });

  it("does not advance offset past a thrown forward failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const updateId = updateIdFromFetchArgs(input, init);
        if (updateId === 11) {
          throw new TypeError("connection refused");
        }
        return new Response(null, { status: 200 });
      })
    );

    await expect(
      forwardUpdates({
        offset: 0,
        secret: "secret",
        signal: new AbortController().signal,
        updates: [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }],
        webhookUrl: "http://127.0.0.1:8792/",
      })
    ).resolves.toBe(11);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledWith(expect.any(TypeError), {
      action: "webhook_forward_failed",
      scope: "telegram-relay",
      updateId: 11,
    });
  });
});
