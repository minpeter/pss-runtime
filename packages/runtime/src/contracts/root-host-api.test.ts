import { describe, expectTypeOf, it } from "vitest";
import type {
  AgentHost,
  CheckpointStore,
  EventStore,
  ExecutionScheduler,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  NotificationRecord,
  ThreadEventLog,
  TurnRecord,
  TurnStore,
} from "../execution";
import type { RuntimeAttachmentStore } from "../index";

describe("runtime host public contracts", () => {
  it("types the single AgentHost contract", () => {
    expectTypeOf<AgentHost["scheduler"]>().toEqualTypeOf<ExecutionScheduler>();
    expectTypeOf<AgentHost["store"]>().toEqualTypeOf<ExecutionStore>();
    expectTypeOf<
      ExecutionStore["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<AgentHost["attachmentStore"]>().toEqualTypeOf<
      RuntimeAttachmentStore | undefined
    >();
    expectTypeOf<ExecutionStore["turns"]>().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      ExecutionStore["checkpoints"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<ExecutionStore["events"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<ExecutionStore["threadEvents"]>().toEqualTypeOf<
      ThreadEventLog | undefined
    >();
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
    expectTypeOf<ExecutionStoreTransaction["threadEvents"]>().toEqualTypeOf<
      ThreadEventLog | undefined
    >();
    expectTypeOf<AgentHost>().not.toHaveProperty("kind");
  });
});
