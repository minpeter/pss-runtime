import { describe, expect, it, vi } from "vitest";

import { forwardUpdates } from "./telegram";

describe("telegram local relay", () => {
  it("does not advance offset past a failed forwarded update", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
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
    expect(errorLog).toHaveBeenCalledWith("webhook 500");
  });

  it("does not advance offset past a thrown forward failure", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
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
    expect(errorLog).toHaveBeenCalledWith(
      "webhook forward failed: connection refused"
    );
  });
});
