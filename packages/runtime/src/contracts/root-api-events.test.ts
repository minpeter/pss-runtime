import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentPluginInterceptResult,
  BeforeToolCall,
  ControlAgentEvent,
  LifecycleAgentEvent,
  TelemetryAgentEvent,
  VisibleAgentEvent,
} from "../index";
import {
  isBeforeToolCallEvent,
  isControlAgentEvent,
  isLifecycleAgentEvent,
  isTelemetryAgentEvent,
  isVisibleAgentEvent,
} from "../index";

describe("runtime root event API exports", () => {
  it("exports event classifiers from the package root", async () => {
    const runtime = await import("../index");

    expect(runtime).toHaveProperty("isVisibleAgentEvent", isVisibleAgentEvent);
    expect(runtime).toHaveProperty(
      "isLifecycleAgentEvent",
      isLifecycleAgentEvent
    );
    expect(runtime).toHaveProperty(
      "isTelemetryAgentEvent",
      isTelemetryAgentEvent
    );
    expect(runtime).toHaveProperty("isControlAgentEvent", isControlAgentEvent);
    expect(runtime).toHaveProperty(
      "isBeforeToolCallEvent",
      isBeforeToolCallEvent
    );
  });

  it("types event classifier exports from the package root", () => {
    const visible = {
      text: "hello",
      type: "assistant-output",
    } satisfies VisibleAgentEvent;
    const lifecycle = { type: "turn-start" } satisfies LifecycleAgentEvent;
    const telemetry = {
      text: "thinking",
      type: "assistant-reasoning",
    } satisfies TelemetryAgentEvent;
    const control = lifecycle satisfies ControlAgentEvent;
    const events = [visible, lifecycle, telemetry, control] satisfies readonly [
      VisibleAgentEvent,
      LifecycleAgentEvent,
      TelemetryAgentEvent,
      Exclude<AgentEvent, VisibleAgentEvent>,
    ];

    expect(events.map((event) => event.type)).toEqual([
      "assistant-output",
      "turn-start",
      "assistant-reasoning",
      "turn-start",
    ]);
  });

  it("types before-tool-call plugin interception results", () => {
    const event = {
      attempt: 1,
      idempotencyKey: "run-1:call_tool-1",
      input: { path: "README.md" },
      policy: "manual-recovery",
      toolCallId: "call_tool-1",
      toolName: "write_file",
      type: "before-tool-call",
    } satisfies BeforeToolCall;
    const continueResult = {
      action: "continue",
    } satisfies AgentPluginInterceptResult;
    const recoveryResult = {
      action: "needs-recovery",
    } satisfies AgentPluginInterceptResult;

    expect(event.toolName).toBe("write_file");
    expect(isBeforeToolCallEvent(event)).toBe(true);
    expect(continueResult.action).toBe("continue");
    expect(recoveryResult.action).toBe("needs-recovery");
  });
});
