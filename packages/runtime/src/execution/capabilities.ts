import type { SessionStore } from "../session/store/types";
import type {
  AgentHostCapabilities,
  CheckpointStore,
  EventStore,
  ExecutionScheduler,
  ExecutionStore,
  NotificationInbox,
  RunStore,
} from "./types";

export interface SessionHost {
  readonly capabilities?: AgentHostCapabilities;
  readonly sessionStore?: SessionStore;
}

export interface RunHost {
  readonly capabilities?: AgentHostCapabilities;
  readonly runStore: RunStore;
}

export interface CheckpointHost {
  readonly capabilities?: AgentHostCapabilities;
  readonly checkpointStore: CheckpointStore;
}

export interface EventHost {
  readonly capabilities?: AgentHostCapabilities;
  readonly eventStore: EventStore;
}

export interface NotificationHost {
  readonly capabilities?: AgentHostCapabilities;
  readonly notificationInbox: NotificationInbox;
}

export type BackgroundScheduler = ExecutionScheduler;

export interface BackgroundSchedulerHost {
  readonly backgroundScheduler: BackgroundScheduler;
  readonly capabilities?: AgentHostCapabilities;
}

export interface ExecutionTransactionHost {
  readonly capabilities?: AgentHostCapabilities;
  readonly transaction: ExecutionStore["transaction"];
}

export interface DurableBackgroundHost
  extends BackgroundSchedulerHost,
    CheckpointHost,
    EventHost,
    ExecutionTransactionHost,
    NotificationHost,
    RunHost,
    SessionHost {
  readonly sessionStore: SessionStore;
}

export interface DurableNotificationResumeHost
  extends BackgroundSchedulerHost,
    CheckpointHost,
    ExecutionTransactionHost,
    NotificationHost,
    RunHost {}
