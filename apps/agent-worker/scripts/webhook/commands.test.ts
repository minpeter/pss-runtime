import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTelegramBotCommandsForToken } from "./commands";

describe("registerTelegramBotCommandsForToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips registration when bot token is unset", async () => {
    const registered = await registerTelegramBotCommandsForToken(undefined);

    expect(registered).toBe(false);
  });

  it("registers slash commands when bot token is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const registered = await registerTelegramBotCommandsForToken("123:abc");

    expect(registered).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:abc/setMyCommands",
      expect.objectContaining({ method: "POST" })
    );
  });
});