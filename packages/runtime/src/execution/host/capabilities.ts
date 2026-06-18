import type { SessionStore } from "../../session/store/types";
import type {
  CheckpointStore,
  EventStore,
  ExecutionScheduler,
  ExecutionStore,
  NotificationInbox,
  RunStore,
} from "./types";

export interface SessionHost {
  readonly kind: "session";
  readonly sessionStore: SessionStore;
}

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

export interface DurableBackgroundHost
  extends BackgroundSchedulerHost,
    CheckpointHost,
    EventHost,
    ExecutionTransactionHost,
    NotificationHost,
    RunHost {
  readonly kind: "durable-background";
  readonly sessionStore: SessionStore;
}
