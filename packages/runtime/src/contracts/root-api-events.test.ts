import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentHooks,
  AgentInputDecision,
  AgentInputEvent,
  AgentTransformDecision,
  ControlAgentEvent,
  LifecycleAgentEvent,
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

  it("types host tool interception decisions", () => {
    const event = {
      attempt: 1,
      idempotencyKey: "run-1:call_tool-1",
      input: { path: "README.md" },
      policy: "manual-recovery",
      toolCallId: "call_tool-1",
      toolName: "write_file",
    } satisfies Parameters<NonNullable<AgentHooks["beforeToolExecution"]>>[0];
    const continueResult = {
      input: event.input,
      status: "continue",
    } satisfies Awaited<
      ReturnType<NonNullable<AgentHooks["beforeToolExecution"]>>
    >;
    const recoveryResult = {
      status: "needs-recovery",
    } satisfies Awaited<
      ReturnType<NonNullable<AgentHooks["beforeToolExecution"]>>
    >;
    const blockResult = {
      output: "path not allowed",
      status: "blocked",
    } satisfies Awaited<
      ReturnType<NonNullable<AgentHooks["beforeToolExecution"]>>
    >;

    expect(event.toolName).toBe("write_file");
    expect(continueResult.status).toBe("continue");
    expect(recoveryResult.status).toBe("needs-recovery");
    expect(blockResult.status).toBe("blocked");
  });

  it("types atomic input and model transforms from the package root", () => {
    const input = {
      value: {
        text: "rewritten",
        type: "user-input",
      },
      action: "transform",
    } satisfies AgentInputDecision<AgentInputEvent>;
    const result = {
      action: "transform",
      value: {
        messages: [{ content: "sanitized", role: "assistant" }],
      },
    } satisfies AgentTransformDecision<{
      readonly messages: readonly {
        readonly content: string;
        readonly role: "assistant";
      }[];
    }>;

    expect(input.value.text).toBe("rewritten");
    expect(result.value.messages).toHaveLength(1);
  });
});
