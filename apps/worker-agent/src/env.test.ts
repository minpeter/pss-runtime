import { describe, expect, it } from "vitest";

import {
  assertWebhookSecretToken,
  readWebhookSecretToken,
  WorkerAgentConfigError,
} from "./env";

describe("worker-agent env helpers", () => {
  it("accepts Telegram-compatible webhook secrets", () => {
    expect(() => assertWebhookSecretToken("abc_123-XYZ")).not.toThrow();
  });

  it("rejects missing webhook secrets", () => {
    expect(() => readWebhookSecretToken({})).toThrow(WorkerAgentConfigError);
  });

  it("rejects bot-token-shaped webhook secrets", () => {
    expect(() =>
      readWebhookSecretToken({ TELEGRAM_WEBHOOK_SECRET_TOKEN: "123:token" })
    ).toThrow("TELEGRAM_WEBHOOK_SECRET_TOKEN");
  });
});
