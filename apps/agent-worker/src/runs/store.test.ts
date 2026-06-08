import { InMemoryCloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import { describe, expect, it } from "vitest";
import { routeWorkerRequest } from "../request/route";
import { readRun, readRunEvents, recordCompletedRun } from "./store";

const route = routeWorkerRequest("https://worker.example/turn", {
  conversationId: "ticket-1",
  tenantId: "tenant-a",
  userId: "user-a",
});

if (!route) {
  throw new Error("test route must be valid");
}

describe("run store", () => {
  it("records deterministic completed run envelopes and event views", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const first = await recordCompletedRun(storage, route, {
      events: [{ text: "done", type: "assistant-text" }],
      markers: ["scenario:foreground-basic"],
      scenario: "foreground-basic",
      summary: {
        assistantText: ["done"],
        counts: { "assistant-text": 1 },
        eventCount: 1,
        eventTypes: ["assistant-text"],
        toolNames: [],
        truncated: false,
      },
    });
    const second = await recordCompletedRun(storage, route, {
      events: [],
      markers: ["scenario:request-rejection"],
      scenario: "request-rejection",
      summary: {
        assistantText: [],
        counts: {},
        eventCount: 0,
        eventTypes: [],
        toolNames: [],
        truncated: false,
      },
    });

    expect(first.runId).toBe("run_0001");
    expect(second.runId).toBe("run_0002");
    await expect(readRun(storage, first.runId)).resolves.toEqual(first);
    await expect(readRunEvents(storage, first.runId)).resolves.toMatchObject({
      events: [{ text: "done", type: "assistant-text" }],
      markers: ["scenario:foreground-basic"],
      runId: "run_0001",
    });
  });
});
