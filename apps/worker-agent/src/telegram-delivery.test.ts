import { beforeEach, describe, expect, it, vi } from "vitest";

import { channelKey } from "./channel";
import type { Env } from "./env";
import { durableObjectName } from "./env";
import { requestAgentDelivery } from "./telegram";

const durableObjectMock = vi.hoisted(
  (): {
    readonly objectNames: string[];
    readonly requests: Request[];
    readonly responses: Response[];
  } => ({
    objectNames: [],
    requests: [],
    responses: [],
  })
);

vi.mock("@minpeter/pss-runtime/platform/cloudflare", () => ({
  fetchCloudflareDurableObject: (options: unknown) => {
    if (
      !(
        typeof options === "object" &&
        options !== null &&
        "request" in options &&
        options.request instanceof Request &&
        "objectName" in options &&
        typeof options.objectName === "string"
      )
    ) {
      throw new Error("Expected Durable Object fetch options.");
    }
    durableObjectMock.objectNames.push(options.objectName);
    durableObjectMock.requests.push(options.request);
    return Promise.resolve(
      durableObjectMock.responses.shift() ?? Response.json({ delivered: true })
    );
  },
}));

describe("agent delivery request", () => {
  beforeEach(() => {
    durableObjectMock.objectNames.length = 0;
    durableObjectMock.requests.length = 0;
    durableObjectMock.responses.length = 0;
  });

  it("sends channel id to the agent Durable Object and accepts tool delivery", async () => {
    const webhookEnv = createWebhookEnv(createDurableObjectNamespace("agent"));
    durableObjectMock.responses.push(Response.json({ delivered: true }));

    await expect(
      requestAgentDelivery(webhookEnv, "channel-1", "hello")
    ).resolves.toBeUndefined();

    const [objectName] = durableObjectMock.objectNames;
    expect(objectName).toBe(
      durableObjectName(channelKey({ id: "channel-1", kind: "telegram" }))
    );

    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("Expected a Durable Object request.");
    }
    await expect(request.json()).resolves.toEqual({
      channel: { id: "channel-1", kind: "telegram" },
      text: "hello",
    });
  });

  it("includes an explicit requester scope when available", async () => {
    const webhookEnv = createWebhookEnv(createDurableObjectNamespace("agent"));
    durableObjectMock.responses.push(Response.json({ delivered: true }));

    await expect(
      requestAgentDelivery(webhookEnv, "channel-1", "hello", {
        sessionScopeKey: "telegram:user:user-1",
      })
    ).resolves.toBeUndefined();

    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("Expected a Durable Object request.");
    }
    await expect(request.json()).resolves.toEqual({
      channel: { id: "channel-1", kind: "telegram" },
      sessionScopeKey: "telegram:user:user-1",
      text: "hello",
    });
  });

  it("rejects when the agent Durable Object reports missing tool delivery", async () => {
    const webhookEnv = createWebhookEnv(createDurableObjectNamespace("agent"));
    durableObjectMock.responses.push(
      Response.json({
        delivered: false,
        error: "missing_send_message",
      })
    );

    await expect(
      requestAgentDelivery(webhookEnv, "channel-1", "hello")
    ).rejects.toThrow("agent did not deliver a send_message result");
  });
});

function createWebhookEnv(namespace: DurableObjectNamespace): Env {
  return {
    AGENT_DO: namespace,
    AI_API_KEY: "test-key",
    ENVIRONMENT: "production",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
  };
}

function createDurableObjectNamespace(label: string): DurableObjectNamespace {
  const namespace: DurableObjectNamespace = {
    get(_id: DurableObjectId) {
      throw new Error(`${label} namespace should not be fetched`);
    },
    getByName(_name: string) {
      throw new Error(`${label} namespace should not be fetched`);
    },
    idFromString(id: string) {
      return createDurableObjectId(id);
    },
    idFromName(name: string) {
      return createDurableObjectId(name);
    },
    jurisdiction() {
      return namespace;
    },
    newUniqueId() {
      return createDurableObjectId(`${label}-unique`);
    },
  };
  return namespace;
}

function createDurableObjectId(name: string): DurableObjectId {
  return {
    equals(other: DurableObjectId) {
      return other.toString() === name;
    },
    name,
    toString() {
      return name;
    },
  };
}
