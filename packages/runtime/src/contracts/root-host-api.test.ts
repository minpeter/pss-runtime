import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CheckpointStore,
  DurableBackgroundHost,
  EventStore,
  ExecutionHost,
  ExecutionScheduler,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  NotificationRecord,
  ThreadHost,
  TurnRecord,
  TurnStore,
} from "../execution";
import type { AgentHost, RuntimeAttachmentStore } from "../index";

describe("runtime host public contracts", () => {
  it("types advanced host contracts", () => {
    expectTypeOf<
      ExecutionHost["scheduler"]
    >().toEqualTypeOf<ExecutionScheduler>();
    expectTypeOf<ExecutionHost["store"]>().toEqualTypeOf<ExecutionStore>();
    expectTypeOf<
      ExecutionStore["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<ExecutionHost["kind"]>().toEqualTypeOf<"execution">();
    expectTypeOf<ExecutionHost["attachmentStore"]>().toEqualTypeOf<
      RuntimeAttachmentStore | undefined
    >();
    expectTypeOf<ExecutionStore["turns"]>().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      ExecutionStore["checkpoints"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<ExecutionStore["events"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<
      Parameters<NotificationInbox["enqueue"]>[0]
    >().toEqualTypeOf<NotificationRecord>();
    expectTypeOf<
      Awaited<ReturnType<TurnStore["get"]>>
    >().toEqualTypeOf<TurnRecord | null>();
    expectTypeOf<
      ExecutionStoreTransaction["turns"]
    >().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      ExecutionStoreTransaction["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    const threadHost = {
      attachmentStore: {} as RuntimeAttachmentStore,
      kind: "thread",
      threadStore: {} as ThreadHost["threadStore"],
    } satisfies ThreadHost;
    const agentHost = threadHost satisfies AgentHost;
    expectTypeOf<ThreadHost["attachmentStore"]>().toEqualTypeOf<
      RuntimeAttachmentStore | undefined
    >();
    expectTypeOf<
      DurableBackgroundHost["turnStore"]
    >().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      DurableBackgroundHost["checkpointStore"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<
      DurableBackgroundHost["eventStore"]
    >().toEqualTypeOf<EventStore>();
    expectTypeOf<
      DurableBackgroundHost["notificationInbox"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<
      DurableBackgroundHost["backgroundScheduler"]
    >().toEqualTypeOf<ExecutionScheduler>();
    expectTypeOf<DurableBackgroundHost["transaction"]>().toEqualTypeOf<
      ExecutionStore["transaction"]
    >();
    expectTypeOf<DurableBackgroundHost["attachmentStore"]>().toEqualTypeOf<
      RuntimeAttachmentStore | undefined
    >();
    expect(agentHost.kind).toBe("thread");
  });
});
