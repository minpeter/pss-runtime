import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRun } from "../index";
import {
  type CloudflareDurableObjectNamespace,
  createCloudflareAgentContext,
  fetchCloudflareDurableObject,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
} from "./index";

describe("Cloudflare Worker DX helpers", () => {
  it("fetches a Durable Object stub by object name", async () => {
    const request = new Request("https://worker.example/turn");
    const response = new Response("proxied", { status: 202 });
    const calls: string[] = [];
    const namespace = {
      get: (id) => ({
        fetch: (receivedRequest) => {
          calls.push(`fetch:${String(id)}:${receivedRequest.url}`);
          return Promise.resolve(response);
        },
      }),
      idFromName: (name) => {
        calls.push(`id:${name}`);
        return name;
      },
    } satisfies CloudflareDurableObjectNamespace;

    await expect(
      fetchCloudflareDurableObject({
        namespace,
        objectName: "tenant-a:user-b",
        request,
      })
    ).resolves.toBe(response);
    expect(calls).toEqual([
      "id:tenant-a:user-b",
      "fetch:tenant-a:user-b:https://worker.example/turn",
    ]);
  });

  it("returns undefined when a Durable Object namespace is absent", async () => {
    await expect(
      fetchCloudflareDurableObject({
        namespace: undefined,
        objectName: "tenant-a",
        request: new Request("https://worker.example/turn"),
      })
    ).resolves.toBeUndefined();
  });

  it("creates prefixed agents and drains scheduled Durable Object alarms", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const calls: string[] = [];
    const context = createCloudflareAgentContext({
      createAgent: ({ env, prefix }) => ({
        resume: (runId) => {
          calls.push(`${env.environment}:${prefix}:${runId}`);
          return Promise.resolve(runWithText(prefix));
        },
      }),
      defaultPrefix: "default-prefix",
      env: { environment: "test" },
      readPrefix: async ({ storage }) => await storage.get<string>("prefix"),
      storage,
    });

    await storage.put("prefix", "tenant-prefix");
    await context
      .host("tenant-prefix")
      .scheduler.enqueueRun("background:bg_context");

    const summary = await context.drainAlarm();

    expect(calls).toEqual(["test:tenant-prefix:background:bg_context"]);
    expect(summary.resumedRuns).toEqual(["background:bg_context"]);
    expect(summary.events).toEqual([
      { text: "tenant-prefix", type: "assistant-text" },
    ]);
    await expect(
      listScheduledCloudflareRuns(storage, { prefix: "tenant-prefix" })
    ).resolves.toEqual([]);
  });
});

function runWithText(text: string): AgentRun {
  return {
    events: () => eventStream([{ text, type: "assistant-text" }]),
  };
}

async function* eventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}
