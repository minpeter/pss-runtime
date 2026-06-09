import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentHostCapabilities,
  BackgroundScheduler,
  BackgroundSchedulerHost,
  CheckpointHost,
  CheckpointStore,
  DurableBackgroundHost,
  DurableNotificationResumeHost,
  EventHost,
  EventStore,
  ExecutionHost,
  ExecutionScheduler,
  ExecutionStore,
  ExecutionStoreTransaction,
  ExecutionTransactionHost,
  NotificationHost,
  NotificationInbox,
  NotificationRecord,
  RunHost,
  RunRecord,
  RunStore,
  SessionHost,
} from "./execution";
import type {
  AgentEvent,
  AgentHost,
  ControlAgentEvent,
  LifecycleAgentEvent,
  TelemetryAgentEvent,
  VisibleAgentEvent,
} from "./index";
import {
  Agent,
  isControlAgentEvent,
  isLifecycleAgentEvent,
  isTelemetryAgentEvent,
  isVisibleAgentEvent,
} from "./index";

type EmptyHostIsAccepted =
  Record<string, never> extends AgentHost ? true : false;
const emptyHostIsAccepted: EmptyHostIsAccepted = true;
const runtimeIndexSourceUrl = new URL("./index.ts", import.meta.url);
const forbiddenRuntimeSubagentExports = [
  ["Subagent", "Definition"].join(""),
  ["resume", "Background", "Child", "Run"].join(""),
  ["Background", "Child", "Agent"].join(""),
  ["Subagent", "Status", "Agent", "Event"].join(""),
  ["is", "Subagent", "Status", "Agent", "Event"].join(""),
] as const;

describe("runtime public exports", () => {
  it("does not expose internal agent loop runner from package root", async () => {
    const runtime = await import("./index");

    expect(runtime).not.toHaveProperty("runAgentLoop");
  });

  it("keeps package root app-facing and omits run stream helpers", async () => {
    const runtime = await import("./index");
    const runStreamExport = ["Agent", "Run", "Stream"].join("");

    expect(runtime).toHaveProperty("Agent", Agent);
    expect(runtime).not.toHaveProperty("createInMemoryExecutionHost");
    expect(runtime).not.toHaveProperty("createCloudflareDurableObjectHost");
    expect(runtime).not.toHaveProperty("BackgroundScheduler");
    expect(runtime).not.toHaveProperty("ToolExecutionNeedsRecoveryError");
    expect(runtime).not.toHaveProperty(runStreamExport);
    expect(emptyHostIsAccepted).toBe(true);
  });

  it("exports event classifiers from the package root", async () => {
    const runtime = await import("./index");

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
  });

  it("does not expose runtime-owned subagent helpers from the package root", async () => {
    const runtime = await import("./index");
    const source = await readFile(runtimeIndexSourceUrl, "utf8");

    for (const forbiddenName of forbiddenRuntimeSubagentExports) {
      expect(runtime).not.toHaveProperty(forbiddenName);
      expect(source).not.toContain(forbiddenName);
    }
  });

  it("types event classifier exports from the package root", () => {
    const visible = {
      text: "hello",
      type: "assistant-text",
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
      "assistant-text",
      "turn-start",
      "assistant-reasoning",
      "turn-start",
    ]);
  });

  it("types advanced host contracts", () => {
    expectTypeOf<
      ExecutionHost["scheduler"]
    >().toEqualTypeOf<ExecutionScheduler>();
    expectTypeOf<ExecutionHost["store"]>().toEqualTypeOf<ExecutionStore>();
    expectTypeOf<
      ExecutionStore["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<
      ExecutionHost["capabilities"]
    >().toEqualTypeOf<AgentHostCapabilities>();
    expectTypeOf<ExecutionStore["runs"]>().toEqualTypeOf<RunStore>();
    expectTypeOf<
      ExecutionStore["checkpoints"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<ExecutionStore["events"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<
      Parameters<NotificationInbox["enqueue"]>[0]
    >().toEqualTypeOf<NotificationRecord>();
    expectTypeOf<
      Awaited<ReturnType<RunStore["get"]>>
    >().toEqualTypeOf<RunRecord | null>();
    expectTypeOf<ExecutionStoreTransaction["runs"]>().toEqualTypeOf<RunStore>();
    expectTypeOf<
      ExecutionStoreTransaction["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    const sessionHost = {} satisfies SessionHost;
    const agentHost = sessionHost satisfies AgentHost;
    expectTypeOf<RunHost["runStore"]>().toEqualTypeOf<RunStore>();
    expectTypeOf<
      CheckpointHost["checkpointStore"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<EventHost["eventStore"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<
      NotificationHost["notificationInbox"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<BackgroundScheduler>().toEqualTypeOf<ExecutionScheduler>();
    expectTypeOf<
      BackgroundSchedulerHost["backgroundScheduler"]
    >().toEqualTypeOf<ExecutionScheduler>();
    expectTypeOf<ExecutionTransactionHost["transaction"]>().toEqualTypeOf<
      ExecutionStore["transaction"]
    >();
    expectTypeOf<DurableBackgroundHost>().toExtend<RunHost>();
    expectTypeOf<DurableNotificationResumeHost>().toExtend<NotificationHost>();
    expect(agentHost).toEqual({});
  });
});
