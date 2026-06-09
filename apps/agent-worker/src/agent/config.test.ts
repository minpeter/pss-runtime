import { describe, expect, it } from "vitest";
import { parseAgentWorkerBindings } from "./config";

describe("parseAgentWorkerBindings", () => {
  it("strips wrangler-only env keys", () => {
    const parsed = parseAgentWorkerBindings({
      AGENT_DURABLE_OBJECT: { idFromName: () => ({}) },
      AI_API_KEY: "test-key",
      TELEGRAM_BOT_TOKEN: "123:abc",
      WORKER_PUBLIC_URL: "https://example.workers.dev",
    });

    expect(parsed.AI_API_KEY).toBe("test-key");
    expect(parsed.TELEGRAM_BOT_TOKEN).toBe("123:abc");
    expect(parsed).not.toHaveProperty("WORKER_PUBLIC_URL");
    expect(parsed).not.toHaveProperty("AGENT_DURABLE_OBJECT");
  });

  it("keeps optional telegram webhook secret", () => {
    const parsed = parseAgentWorkerBindings({
      AI_API_KEY: "test-key",
      TELEGRAM_WEBHOOK_SECRET: "random-secret",
    });

    expect(parsed.TELEGRAM_WEBHOOK_SECRET).toBe("random-secret");
  });
});