import type { RuntimeAttachmentStore } from "../../thread/input/attachments";
import type { ThreadStore } from "../../thread/store/types";
import type {
  CheckpointStore,
  EventStore,
  ExecutionScheduler,
  ExecutionStore,
  NotificationInbox,
  TurnStore,
} from "./types";

export interface ThreadHost {
  readonly attachmentStore?: RuntimeAttachmentStore;
  readonly kind: "thread";
  readonly threadStore: ThreadStore;
}

interface ThreadStoreHost {
  readonly threadStore: ThreadStore;
}

interface TurnHost {
  readonly turnStore: TurnStore;
}

interface CheckpointHost {
  readonly checkpointStore: CheckpointStore;
}

interface EventHost {
  readonly eventStore: EventStore;
}

interface NotificationHost {
  readonly notificationInbox: NotificationInbox;
}

interface BackgroundSchedulerHost {
  readonly backgroundScheduler: ExecutionScheduler;
}

interface ExecutionTransactionHost {
  readonly transaction: ExecutionStore["transaction"];
}

export type DurableBackgroundHost = BackgroundSchedulerHost &
  EventHost &
  ExecutionTransactionHost &
  NotificationHost &
  CheckpointHost &
  ThreadStoreHost & {
    readonly attachmentStore?: RuntimeAttachmentStore;
    readonly kind: "durable-background";
  } & TurnHost;
