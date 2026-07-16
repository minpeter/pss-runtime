import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  ControlAgentEvent,
  LifecycleAgentEvent,
  PluginRequestResultMap,
  PluginToolCallBeforeEvent,
  TelemetryAgentEvent,
  VisibleAgentEvent,
} from "../index";
import {
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
    expect(runtime).not.toHaveProperty("isBeforeToolCallEvent");
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

  it("types plugin-only tool.call.before interception results", () => {
    const event = {
      attempt: 1,
      idempotencyKey: "run-1:call_tool-1",
      input: { path: "README.md" },
      policy: "manual-recovery",
      toolCallId: "call_tool-1",
      toolName: "write_file",
      type: "tool.call.before",
    } satisfies PluginToolCallBeforeEvent;
    const continueResult = {
      action: "continue",
    } satisfies PluginRequestResultMap["tool.call.before"];
    const recoveryResult = {
      action: "needs-recovery",
    } satisfies PluginRequestResultMap["tool.call.before"];

    expect(event.toolName).toBe("write_file");
    expect(event.type).toBe("tool.call.before");
    expect(continueResult.action).toBe("continue");
    expect(recoveryResult.action).toBe("needs-recovery");
  });

  it("types atomic model step transforms from the package root", () => {
    const result = {
      action: "transform",
      value: {
        messages: [{ content: "sanitized", role: "assistant" }],
      },
    } satisfies PluginRequestResultMap["model.step.before"];

    expect(result.value.messages).toHaveLength(1);
  });
});
