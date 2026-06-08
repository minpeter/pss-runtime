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
import type { AgentHost } from "./index";
import { Agent } from "./index";

type EmptyHostIsAccepted =
  Record<string, never> extends AgentHost ? true : false;
const emptyHostIsAccepted: EmptyHostIsAccepted = true;

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
    expectTypeOf<SessionHost>().toMatchTypeOf<AgentHost>();
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
    expectTypeOf<DurableBackgroundHost>().toMatchTypeOf<RunHost>();
    expectTypeOf<DurableNotificationResumeHost>().toMatchTypeOf<NotificationHost>();
  });
});
