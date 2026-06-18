import type {
  DurableBackgroundHost,
  DurableNotificationResumeHost,
  SessionHost,
} from "./capabilities";
import type { AgentHost, ExecutionHost } from "./types";

type Transaction = ExecutionHost["store"]["transaction"];

export function sessionHost(host: AgentHost): SessionHost {
  switch (host.kind) {
    case "session":
      return host;
    case "durable-background":
      return { kind: "session", sessionStore: host.sessionStore };
    case "execution":
      return { kind: "session", sessionStore: host.store.sessions };
    default:
      return assertNeverHost(host);
  }
}

export function executionHost(host: AgentHost): ExecutionHost | undefined {
  if (host.kind === "execution") {
    return host;
  }

  if (host.kind === "durable-background") {
    return executionHostFromDurableBackgroundHost(host);
  }

  return;
}

export function durableBackgroundHost(
  host: AgentHost
): DurableBackgroundHost | undefined {
  if (host.kind === "durable-background") {
    return host;
  }

  if (host.kind === "execution") {
    return durableBackgroundHostFromExecutionHost(host);
  }

  return;
}

export function durableNotificationResumeHost(
  host: AgentHost
): DurableNotificationResumeHost | undefined {
  const backgroundHost = durableBackgroundHost(host);
  if (backgroundHost) {
    return {
      backgroundScheduler: backgroundHost.backgroundScheduler,
      checkpointStore: backgroundHost.checkpointStore,
      kind: "durable-notification-resume",
      notificationInbox: backgroundHost.notificationInbox,
      runStore: backgroundHost.runStore,
      transaction: backgroundHost.transaction,
    };
  }

  return;
}

function durableBackgroundHostFromExecutionHost(
  host: ExecutionHost
): DurableBackgroundHost {
  return {
    backgroundScheduler: host.scheduler,
    checkpointStore: host.store.checkpoints,
    eventStore: host.store.events,
    kind: "durable-background",
    notificationInbox: host.store.notifications,
    runStore: host.store.runs,
    sessionStore: host.store.sessions,
    transaction: transactionForStore(host.store),
  };
}

function executionHostFromDurableBackgroundHost(
  host: DurableBackgroundHost
): ExecutionHost {
  return {
    kind: "execution",
    scheduler: host.backgroundScheduler,
    store: {
      checkpoints: host.checkpointStore,
      events: host.eventStore,
      notifications: host.notificationInbox,
      runs: host.runStore,
      sessions: host.sessionStore,
      transaction: host.transaction,
    },
  };
}

function transactionForStore(store: ExecutionHost["store"]): Transaction {
  return (fn) => store.transaction(fn);
}

function assertNeverHost(host: never): never {
  throw new Error(`Unsupported agent host: ${JSON.stringify(host)}`);
}
