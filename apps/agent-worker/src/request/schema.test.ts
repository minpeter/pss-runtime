import { describe, expect, it } from "vitest";
import { readTurnRequest } from "./http";
import { routeWorkerRequest } from "./route";
import {
  appBudgets,
  parseTurnBody,
  scenarioIds,
  totalHeaderBytes,
} from "./schema";

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
      "long-running-pingpong",
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
    expect(
      parseTurnBody({
        conversationId: "ticket-1",
        input: "hello",
        scenario: "long-running-pingpong",
        stress: { pingPongHops: appBudgets.maxPingPongHops + 1 },
        tenantId: "tenant-a",
        userId: "user-a",
      }).status
    ).toBe(400);
    expect(
      parseTurnBody({
        conversationId: "ticket-1",
        input: "hello",
        scenario: "long-running-pingpong",
        stress: { pingPongDelayMs: appBudgets.maxPingPongDelayMs + 1 },
        tenantId: "tenant-a",
        userId: "user-a",
      }).status
    ).toBe(400);
  });

  it("accepts bounded long-running ping-pong stress knobs", () => {
    const parsed = parseTurnBody({
      conversationId: "ticket-1",
      input: "hello",
      scenario: "long-running-pingpong",
      stress: { pingPongDelayMs: 60_000, pingPongHops: 6 },
      tenantId: "tenant-a",
      userId: "user-a",
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.stress : undefined).toMatchObject({
      pingPongDelayMs: 60_000,
      pingPongHops: 6,
    });
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

  it("rejects declared oversized bodies before reading request text", async () => {
    const result = await readTurnRequest({
      headers: new Headers([
        ["content-length", String(appBudgets.maxBodyBytes + 1)],
      ]),
      text: () => Promise.reject(new Error("request text should not be read")),
    });

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects oversized streamed bodies without using request text", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(appBudgets.maxBodyBytes + 1));
        controller.close();
      },
    });
    const result = await readTurnRequest({
      body,
      headers: new Headers(),
      text: () => Promise.reject(new Error("request text should not be read")),
    });

    expect(result).toMatchObject({ ok: false, status: 413 });
  });
});
