import {
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
} from "@minpeter/pss-runtime/cloudflare";
import { describe, expect, it } from "vitest";
import { routeWorkerRequest } from "../request/route";
import { parseTurnBody } from "../request/schema";
import { runStressScenario } from ".";

const route = routeWorkerRequest("https://worker.example/turn", {
  conversationId: "ticket-1",
  tenantId: "tenant-a",
  userId: "user-a",
});

if (!route) {
  throw new Error("test route must be valid");
}

describe("long-running ping-pong scenario", () => {
  it("models more than five minutes through bounded alarm handoffs", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const parsed = parseTurnBody({
      conversationId: route.conversationId,
      input: "exercise long running work",
      scenario: "long-running-pingpong",
      stress: { pingPongDelayMs: 60_000, pingPongHops: 6 },
      tenantId: route.tenantId,
      userId: route.userId,
    });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    const result = await runStressScenario({
      env: {},
      request: parsed.value,
      route,
      storage,
    });

    expect(result.markers).toEqual(
      expect.arrayContaining([
        "scenario:long-running-pingpong",
        "pingpong:hops:6",
        "pingpong:delay-ms:60000",
        "pingpong:elapsed-ms:360000",
        "long-running:over-5m",
      ])
    );
    expect(result.summary.counts["assistant-text"]).toBe(6);
    await expect(
      listScheduledCloudflareRuns(storage, { prefix: route.storePrefix })
    ).resolves.toEqual([]);
  });
});
