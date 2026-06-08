import {
  type CloudflareDurableObjectState,
  InMemoryCloudflareDurableObjectStorage,
} from "@minpeter/pss-runtime/cloudflare";
import { describe, expect, it } from "vitest";
import { AgentDurableObject } from ".";

describe("agent worker run routes", () => {
  it("creates completed run envelopes and serves run event evidence", async () => {
    const object = new AgentDurableObject(
      stateFor(new InMemoryCloudflareDurableObjectStorage()),
      {}
    );
    const created = await object.fetch(
      new Request("https://worker.example/runs", {
        body: JSON.stringify({
          conversationId: "ticket-1",
          input: "edit the isolated file",
          scenario: "user-sandbox-file-edit",
          tenantId: "tenant-a",
          userId: "user-a",
        }),
        method: "POST",
      })
    );
    const run = await created.json();
    const details = await object.fetch(
      new Request(
        "https://worker.example/runs/run_0001?tenant=tenant-a&user=user-a&conversation=ticket-1"
      )
    );
    const events = await object.fetch(
      new Request(
        "https://worker.example/runs/run_0001/events?tenant=tenant-a&user=user-a&conversation=ticket-1"
      )
    );

    expect(created.status).toBe(201);
    expect(run).toMatchObject({
      result: { scenario: "user-sandbox-file-edit" },
      runId: "run_0001",
      status: "completed",
    });
    await expect(details.json()).resolves.toMatchObject({
      runId: "run_0001",
      status: "completed",
    });
    await expect(events.json()).resolves.toMatchObject({
      evidence: { type: "user-sandbox-file-edit" },
      runId: "run_0001",
    });
  });

  it("serves public agent-friendly docs without bearer auth", async () => {
    const object = new AgentDurableObject(
      stateFor(new InMemoryCloudflareDurableObjectStorage()),
      {}
    );
    const llms = await object.fetch(
      new Request("https://worker.example/llms.txt")
    );
    const scenario = await object.fetch(
      new Request("https://worker.example/scenarios/user-sandbox-file-edit")
    );
    const openapi = await object.fetch(
      new Request("https://worker.example/openapi.json")
    );

    await expect(llms.text()).resolves.toContain("/openapi.json");
    await expect(scenario.json()).resolves.toMatchObject({
      id: "user-sandbox-file-edit",
    });
    await expect(openapi.json()).resolves.toMatchObject({
      openapi: "3.1.0",
    });
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
