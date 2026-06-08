import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentHostCapabilities,
  CheckpointStore,
  EventStore,
  ExecutionHost,
  ExecutionScheduler,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  NotificationRecord,
  RunRecord,
  RunStore,
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
  });
});
