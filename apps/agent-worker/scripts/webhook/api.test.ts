import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTelegramBotCommands } from "./api";

describe("registerTelegramBotCommands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers slash commands with Telegram", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await registerTelegramBotCommands("123:abc");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:abc/setMyCommands",
      {
        body: JSON.stringify({
          commands: [
            { command: "help", description: "Show help" },
            { command: "start", description: "Show help" },
            { command: "debug_reset", description: "Reset conversation" },
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
  });
});