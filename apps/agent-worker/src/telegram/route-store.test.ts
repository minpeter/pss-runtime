import { InMemoryCloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import { describe, expect, it } from "vitest";
import { readTelegramRoute, writeTelegramRoute } from "./route-store";

describe("telegram route store", () => {
  it("writes and reads the conversation route", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const route = {
      chatId: "chat-1",
      sessionKey: "telegram:thread:chat-1:user:user-1",
      storePrefix: "telegram-chat:thread:chat-1:user:user-1",
      userId: "user-1",
    };

    await writeTelegramRoute(storage, route);
    await expect(readTelegramRoute(storage)).resolves.toEqual(route);
  });
});
