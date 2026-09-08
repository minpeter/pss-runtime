import { describe, expect, it } from "vitest";

import {
  assertWebhookSecretToken,
  durableObjectName,
  isTelegramIngressDryRun,
  readTelegramApiBaseUrl,
  readWebhookSecretToken,
  WorkerAgentConfigError,
} from "./env";

const DURABLE_OBJECT_NAME_PATTERN = /^tg-v1-[A-Za-z0-9_-]*$/u;

describe("worker-agent env helpers", () => {
  it("accepts Telegram-compatible webhook secrets", () => {
    expect(() => assertWebhookSecretToken("abc_123-XYZ")).not.toThrow();
  });

  it("detects Layer 1 ingress dry-run flags", () => {
    expect(isTelegramIngressDryRun({})).toBe(false);
    expect(isTelegramIngressDryRun({ TELEGRAM_INGRESS_DRY_RUN: "0" })).toBe(
      false
    );
    expect(isTelegramIngressDryRun({ TELEGRAM_INGRESS_DRY_RUN: "1" })).toBe(
      true
    );
    expect(isTelegramIngressDryRun({ TELEGRAM_INGRESS_DRY_RUN: "true" })).toBe(
      true
    );
  });

  it("rejects missing webhook secrets", () => {
    expect(() => readWebhookSecretToken({})).toThrow(WorkerAgentConfigError);
  });

  it("reads the Telegram API base override trimmed, undefined when blank", () => {
    expect(readTelegramApiBaseUrl({})).toBeUndefined();
    expect(
      readTelegramApiBaseUrl({ TELEGRAM_API_BASE_URL: "   " })
    ).toBeUndefined();
    expect(
      readTelegramApiBaseUrl({
        TELEGRAM_API_BASE_URL: "  http://127.0.0.1:8793  ",
      })
    ).toBe("http://127.0.0.1:8793");
  });

  it("rejects bot-token-shaped webhook secrets", () => {
    expect(() =>
      readWebhookSecretToken({ TELEGRAM_WEBHOOK_SECRET_TOKEN: "123:token" })
    ).toThrow("TELEGRAM_WEBHOOK_SECRET_TOKEN");
  });

  it("encodes durable object names without replacing channel separators", () => {
    expect(durableObjectName("a:b")).toBe("tg-v1-YTpi");
    expect(durableObjectName("a/b")).toBe("tg-v1-YS9i");
    expect(durableObjectName("a:b")).not.toBe(durableObjectName("a/b"));
  });

  it("keeps durable object names URL-safe while preserving distinct channel IDs", () => {
    const names = [
      durableObjectName("chat:123/thread/456"),
      durableObjectName("chat/123:thread:456"),
      durableObjectName("chat_123-thread_456"),
    ];

    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(DURABLE_OBJECT_NAME_PATTERN);
    }
  });
});
