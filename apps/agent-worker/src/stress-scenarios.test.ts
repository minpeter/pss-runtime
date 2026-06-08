import { describe, expect, it } from "vitest";
import { InMemoryCloudflareDurableObjectStorage } from "./cloudflare-host";
import { appBudgets, parseTurnBody, scenarioIds } from "./request-schema";
import { createHealthPayload, runStressScenario } from "./stress-scenarios";
import worker, {
  AgentDurableObject,
  type CloudflareDurableObjectState,
} from "./worker";
import { routeWorkerRequest } from "./worker-route";

const route = routeWorkerRequest("https://worker.example/turn", {
  conversationId: "ticket-1",
  tenantId: "tenant-a",
  userId: "user-a",
});

if (!route) {
  throw new Error("test route must be valid");
}

describe("agent worker stress scenarios", () => {
  it("returns health metadata with scenario ids and binding presence", () => {
    expect(createHealthPayload({ bindingPresent: true })).toMatchObject({
      app: "pss-agent-worker",
      bindingPresent: true,
      scenarioIds,
    });
  });

  it("serves health, rejects invalid turn bodies, and stores bounded events", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const object = new AgentDurableObject(stateFor(storage), {});
    const health = await worker.fetch(
      new Request("https://worker.example/health"),
      {}
    );
    const invalid = await object.fetch(
      new Request("https://worker.example/turn", {
        body: JSON.stringify({}),
        method: "POST",
      })
    );
    const oversizedHeader = await object.fetch(
      new Request("https://worker.example/turn", {
        body: JSON.stringify({}),
        headers: { "x-fill": "x".repeat(appBudgets.maxHeaderBytes) },
        method: "POST",
      })
    );
    const oversizedBody = await object.fetch(
      new Request("https://worker.example/turn", {
        body: "x".repeat(appBudgets.maxBodyBytes + 1),
        method: "POST",
      })
    );
    const turn = await object.fetch(
      new Request("https://worker.example/turn", {
        body: JSON.stringify({
          conversationId: route.conversationId,
          input: "hello",
          scenario: "foreground-basic",
          tenantId: route.tenantId,
          userId: route.userId,
        }),
        method: "POST",
      })
    );
    const events = await object.fetch(
      new Request(
        "https://worker.example/events?tenant=tenant-a&user=user-a&conversation=ticket-1"
      )
    );

    await expect(health.json()).resolves.toMatchObject({
      app: "pss-agent-worker",
      bindingPresent: false,
    });
    expect(invalid.status).toBe(400);
    expect(oversizedHeader.status).toBe(431);
    expect(oversizedBody.status).toBe(413);
    expect(turn.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      markers: ["scenario:foreground-basic"],
    });
  });

  it("runs every scenario deterministically", async () => {
    for (const scenario of scenarioIds) {
      const parsed = parseTurnBody({
        conversationId: route.conversationId,
        input: "exercise the scenario",
        scenario,
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
        storage: new InMemoryCloudflareDurableObjectStorage(),
      });

      expect(result.scenario).toBe(scenario);
      expect(result.markers).toContain(`scenario:${scenario}`);
      expect(result.summary.eventCount).toBeLessThanOrEqual(
        appBudgets.maxSummaryEvents
      );
    }
  });

  it("caps event summaries and keeps alarm markers compact", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const parsed = parseTurnBody({
      conversationId: route.conversationId,
      input: "complete background work",
      scenario: "background-output",
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
      expect.arrayContaining(["request-boundary:launch", "alarm:resume"])
    );
    expect(result.summary.eventTypes.length).toBeLessThanOrEqual(
      appBudgets.maxSummaryEvents
    );
    expect(JSON.stringify(result.summary).length).toBeLessThan(
      appBudgets.maxSummaryBytes
    );
  });
});

function stateFor(
  storage: InMemoryCloudflareDurableObjectStorage
): CloudflareDurableObjectState {
  return {
    storage,
    waitUntil: (promise) => {
      promise.catch((error: unknown) => {
        throw error;
      });
    },
  };
}
