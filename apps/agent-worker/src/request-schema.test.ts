import { describe, expect, it } from "vitest";
import {
  appBudgets,
  parseTurnBody,
  scenarioIds,
  totalHeaderBytes,
} from "./request-schema";
import { routeWorkerRequest } from "./worker-route";

describe("agent worker request schema", () => {
  it("lists every deterministic stress scenario", () => {
    expect(scenarioIds).toEqual([
      "foreground-basic",
      "multipart-input",
      "plugin-events",
      "tool-choice",
      "blocking-subagent",
      "durable-background",
      "background-output",
      "background-cancel",
      "steer-step-end",
      "duplicate-alarm",
      "resume-retry",
      "cancel-stale-child",
      "request-rejection",
      "fanout-guard",
      "large-history-guard",
      "checkpoint-size-guard",
      "budget-guard",
    ]);
  });

  it("accepts bounded multipart input", () => {
    const parsed = parseTurnBody({
      conversationId: "ticket-1",
      input: [
        { text: "inspect", type: "text" },
        { image: "iVBORw0KGgo=", mediaType: "image/png", type: "image" },
        {
          data: { text: "log excerpt", type: "text" },
          filename: "log.txt",
          mediaType: "text/plain",
          type: "file",
        },
      ],
      scenario: "multipart-input",
      tenantId: "tenant-a",
      userId: "user-a",
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.input : undefined).toEqual({
      content: [
        { text: "inspect", type: "text" },
        { image: "iVBORw0KGgo=", mediaType: "image/png", type: "image" },
        {
          data: { text: "log excerpt", type: "text" },
          filename: "log.txt",
          mediaType: "text/plain",
          type: "file",
        },
      ],
      type: "user-message",
    });
  });

  it("rejects route, body, fanout, and checkpoint budgets before platform limits", () => {
    expect(parseTurnBody({}).status).toBe(400);
    expect(
      parseTurnBody({
        conversationId: "ticket-1",
        input: "hello",
        scenario: "fanout-guard",
        stress: { fanout: appBudgets.maxFanout + 1 },
        tenantId: "tenant-a",
        userId: "user-a",
      }).status
    ).toBe(400);
    expect(
      parseTurnBody({
        conversationId: "ticket-1",
        input: "hello",
        scenario: "checkpoint-size-guard",
        stress: { checkpointBytes: appBudgets.maxCheckpointBytes + 1 },
        tenantId: "tenant-a",
        userId: "user-a",
      }).status
    ).toBe(400);
  });

  it("computes bounded header size and isolated route keys", () => {
    const headers = new Headers([
      ["x-tenant", "a"],
      ["x-request-id", "123"],
    ]);
    const first = routeWorkerRequest("https://worker.example/turn", {
      conversationId: "ticket-1",
      tenantId: "tenant-a",
      userId: "user-a",
    });
    const second = routeWorkerRequest("https://worker.example/turn", {
      conversationId: "ticket-1",
      tenantId: "tenant-a",
      userId: "user-b",
    });

    expect(totalHeaderBytes(headers)).toBeLessThan(appBudgets.maxHeaderBytes);
    expect(first?.objectName).not.toBe(second?.objectName);
    expect(first?.sessionKey).not.toBe(second?.sessionKey);
    expect(first?.storePrefix).not.toBe(second?.storePrefix);
  });

  it("rejects oversized query route tokens before object lookup", () => {
    const tooLong = "x".repeat(appBudgets.maxRouteTokenChars + 1);

    expect(
      routeWorkerRequest(
        `https://worker.example/events?tenant=${tooLong}&user=user-a&conversation=ticket-1`,
        {}
      )
    ).toBeUndefined();
  });
});
