import { describe, expectTypeOf, it } from "vitest";
import type {
  AgentHost,
  CheckpointStore,
  EventStore,
  HostScheduler,
  HostStore,
  HostStoreTransaction,
  NotificationInbox,
  NotificationRecord,
  ThreadEventLog,
  TurnRecord,
  TurnStore,
} from "../execution";
import type { HostAttachmentStore } from "../index";

describe("runtime host public contracts", () => {
  it("types the single AgentHost contract", () => {
    expectTypeOf<AgentHost["scheduler"]>().toEqualTypeOf<HostScheduler>();
    expectTypeOf<AgentHost["store"]>().toEqualTypeOf<HostStore>();
    expectTypeOf<
      HostStore["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<AgentHost["attachmentStore"]>().toEqualTypeOf<
      HostAttachmentStore | undefined
    >();
    expectTypeOf<HostStore["turns"]>().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      HostStore["checkpoints"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<HostStore["events"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<HostStore["threadEvents"]>().toEqualTypeOf<
      ThreadEventLog | undefined
    >();
    expectTypeOf<
      Parameters<NotificationInbox["enqueue"]>[0]
    >().toEqualTypeOf<NotificationRecord>();
    expectTypeOf<
      Awaited<ReturnType<TurnStore["get"]>>
    >().toEqualTypeOf<TurnRecord | null>();
    expectTypeOf<
      HostStoreTransaction["turns"]
    >().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      HostStoreTransaction["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<HostStoreTransaction["threadEvents"]>().toEqualTypeOf<
      ThreadEventLog | undefined
    >();
    expectTypeOf<AgentHost>().not.toHaveProperty("kind");
  });
});
