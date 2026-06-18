import type { SessionStore } from "../session/store/types";
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

export interface RunHost {
  readonly runStore: RunStore;
}

export interface CheckpointHost {
  readonly checkpointStore: CheckpointStore;
}

export interface EventHost {
  readonly eventStore: EventStore;
}

export interface NotificationHost {
  readonly notificationInbox: NotificationInbox;
}

export type BackgroundScheduler = ExecutionScheduler;

export interface BackgroundSchedulerHost {
  readonly backgroundScheduler: BackgroundScheduler;
}

export interface ExecutionTransactionHost {
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

export interface DurableNotificationResumeHost
  extends BackgroundSchedulerHost,
    CheckpointHost,
    ExecutionTransactionHost,
    NotificationHost,
    RunHost {
  readonly kind: "durable-notification-resume";
}
