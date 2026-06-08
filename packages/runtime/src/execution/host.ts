import type {
  DurableBackgroundHost,
  DurableNotificationResumeHost,
  SessionHost,
} from "./capabilities";
import type { AgentHost, ExecutionHost } from "./types";

type Transaction = ExecutionHost["store"]["transaction"];

export function sessionHost(host: AgentHost): SessionHost {
  const durableHost = durableBackgroundHost(host);
  if (durableHost?.sessionStore) {
    return durableHost;
  }

  const hostExecution = executionHost(host);
  if (hostExecution) {
    return {
      capabilities: hostExecution.capabilities,
      sessionStore: hostExecution.store.sessions,
    };
  }

  return host;
}

export function executionHost(host: AgentHost): ExecutionHost | undefined {
  if (isExecutionHost(host)) {
    return host;
  }

  if (isDurableBackgroundHost(host)) {
    return executionHostFromDurableBackgroundHost(host);
  }

  return;
}

export function durableBackgroundHost(
  host: AgentHost
): DurableBackgroundHost | undefined {
  const hostExecution = executionHost(host);
  if (hostExecution) {
    return durableBackgroundHostFromExecutionHost(hostExecution);
  }

  if (isDurableBackgroundHost(host)) {
    return host;
  }

  return;
}

export function durableNotificationResumeHost(
  host: AgentHost
): DurableNotificationResumeHost | undefined {
  const backgroundHost = durableBackgroundHost(host);
  if (backgroundHost?.capabilities?.backgroundSubagents === "durable") {
    return backgroundHost;
  }

  return;
}

function isExecutionHost(host: AgentHost): host is ExecutionHost {
  return "scheduler" in host && "store" in host && isExecutionStore(host.store);
}

function isExecutionStore(store: unknown): store is ExecutionHost["store"] {
  return (
    typeof store === "object" &&
    store !== null &&
    "checkpoints" in store &&
    "events" in store &&
    "notifications" in store &&
    "runs" in store &&
    "sessions" in store
  );
}

function durableBackgroundHostFromExecutionHost(
  host: ExecutionHost
): DurableBackgroundHost {
  return {
    backgroundScheduler: host.scheduler,
    capabilities: host.capabilities,
    checkpointStore: host.store.checkpoints,
    eventStore: host.store.events,
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
    capabilities: host.capabilities ?? {},
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

function isDurableBackgroundHost(
  host: AgentHost
): host is DurableBackgroundHost {
  return (
    "backgroundScheduler" in host &&
    "checkpointStore" in host &&
    "eventStore" in host &&
    "notificationInbox" in host &&
    "runStore" in host &&
    "sessionStore" in host &&
    "transaction" in host
  );
}

function transactionForStore(store: ExecutionHost["store"]): Transaction {
  return (fn) => store.transaction(fn);
}
