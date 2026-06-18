import type { ThreadStore } from "../../thread/store/types";
import type {
  CheckpointStore,
  EventStore,
  ExecutionScheduler,
  ExecutionStore,
  NotificationInbox,
  RunStore,
} from "./types";

export interface ThreadHost {
  readonly kind: "thread";
  readonly threadStore: ThreadStore;
}

interface ThreadStoreHost {
  readonly sessionStore?: ThreadStore;
  readonly threadStore: ThreadStore;
}

interface LegacySessionStoreHost {
  readonly sessionStore: ThreadStore;
  readonly threadStore?: ThreadStore;
}

type ThreadStoreCompatibilityHost = LegacySessionStoreHost | ThreadStoreHost;

export type LegacySessionHost = {
  readonly kind: "session";
} & ThreadStoreCompatibilityHost;

/** @deprecated Use ThreadHost. */
export type SessionHost = LegacySessionHost;

interface RunHost {
  readonly runStore: RunStore;
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
  CheckpointHost &
  EventHost &
  ExecutionTransactionHost &
  NotificationHost &
  RunHost &
  ThreadStoreCompatibilityHost & {
    readonly kind: "durable-background";
  };
