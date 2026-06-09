import { describe, expect, it } from "vitest";
import {
  resolveTelegramWebhookSecret,
  telegramWebhookSecretFromBotToken,
} from "./webhook-secret";

describe("resolveTelegramWebhookSecret", () => {
  it("prefers explicit webhook secret", () => {
    expect(
      resolveTelegramWebhookSecret({
        botToken: "123:abc",
        webhookSecret: "independent-secret",
      })
    ).toBe("independent-secret");
  });

  it("falls back to bot token derivation", () => {
    expect(
      resolveTelegramWebhookSecret({
        botToken: "123:abc",
      })
    ).toBe(telegramWebhookSecretFromBotToken("123:abc"));
  });
});