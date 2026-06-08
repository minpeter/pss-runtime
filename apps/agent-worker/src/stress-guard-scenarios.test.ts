import { InMemoryCloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import { describe, expect, it } from "vitest";
import { appBudgets, parseTurnBody } from "./request-schema";
import { scenarioResult } from "./stress-result";
import { runStressScenario } from "./stress-scenarios";
import { summarizeEvents } from "./worker-metrics";
import { routeWorkerRequest } from "./worker-route";

const route = routeWorkerRequest("https://worker.example/turn", {
  conversationId: "ticket-1",
  tenantId: "tenant-a",
  userId: "user-a",
});

if (!route) {
  throw new Error("test route must be valid");
}

describe("agent worker guard scenarios", () => {
  it("uses stress knobs for guard scenarios and response summary caps", async () => {
    const parsed = parseTurnBody({
      conversationId: route.conversationId,
      input: "guard the worker",
      scenario: "large-history-guard",
      stress: {
        historyItems: appBudgets.maxHistoryItems,
        summaryEvents: 2,
      },
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

    expect(result.markers).toEqual(
      expect.arrayContaining([
        "scenario:large-history-guard",
        `history-items:${appBudgets.maxHistoryItems}`,
        "summary-events:2",
      ])
    );
    expect(result.events.length).toBeLessThanOrEqual(2);
    expect(result.summary.eventCount).toBeLessThanOrEqual(2);
    expect(result.summary.truncated).toBe(true);
  });

  it("exercises fanout and checkpoint guard profiles inside app budgets", async () => {
    for (const [scenario, stress, expectedMarker] of [
      ["fanout-guard", { fanout: 3 }, "fanout:3"],
      [
        "checkpoint-size-guard",
        { checkpointBytes: appBudgets.maxCheckpointBytes },
        `checkpoint-bytes:${appBudgets.maxCheckpointBytes}`,
      ],
      ["budget-guard", { summaryEvents: 3 }, "summary-events:3"],
    ] as const) {
      const parsed = parseTurnBody({
        conversationId: route.conversationId,
        input: "guard the worker",
        scenario,
        stress,
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

      expect(result.markers).toContain(expectedMarker);
      expect(JSON.stringify(result.events).length).toBeLessThanOrEqual(
        appBudgets.maxSummaryBytes
      );
    }
  });

  it("keeps steer control on the worker coordinator path", async () => {
    const parsed = parseTurnBody({
      conversationId: route.conversationId,
      input: "steer after step end",
      scenario: "steer-step-end",
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

    expect(result.markers).toContain("session.steer:step-end");
    expect(result.summary.assistantText).toContain("DONE");
  });

  it("summarizes without returning unbounded event logs", () => {
    const summary = summarizeEvents(
      Array.from({ length: appBudgets.maxSummaryEvents + 5 }, () => ({
        text: "visible",
        type: "assistant-text" as const,
      }))
    );

    expect(summary.eventCount).toBe(appBudgets.maxSummaryEvents);
    expect(summary.truncated).toBe(true);
  });

  it("applies request stress options to returned event summaries", async () => {
    const parsed = parseTurnBody({
      conversationId: route.conversationId,
      input: "exercise a compact summary",
      scenario: "tool-choice",
      stress: { summaryEvents: 2 },
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

    expect(result.summary.eventCount).toBeLessThanOrEqual(2);
    expect(result.events.length).toBeLessThanOrEqual(2);
  });

  it("caps serialized event payload bytes", () => {
    const result = scenarioResult(
      "foreground-basic",
      [
        {
          text: "x".repeat(appBudgets.maxSummaryBytes),
          type: "assistant-text",
        },
      ],
      ["scenario:foreground-basic"]
    );

    expect(
      new TextEncoder().encode(JSON.stringify(result.events)).byteLength
    ).toBeLessThanOrEqual(appBudgets.maxSummaryBytes);
    expect(result.summary.truncated).toBe(true);
  });

  it("uses bounded stress knobs in guard scenarios", async () => {
    const parsed = parseTurnBody({
      conversationId: route.conversationId,
      input: "exercise bounded guards",
      scenario: "fanout-guard",
      stress: { fanout: 3, historyItems: 4 },
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

    expect(result.markers).toEqual(
      expect.arrayContaining(["fanout:3/6", "history:4/32"])
    );
  });
});
