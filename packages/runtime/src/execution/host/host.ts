import type {
  DurableBackgroundHost,
  SessionHost,
  ThreadHost,
} from "./capabilities";
import type { AgentHost, ExecutionHost, ExecutionStorePorts } from "./types";

type Transaction = ExecutionHost["store"]["transaction"];
interface CompatibleThreadStoreHost {
  readonly sessionStore?: ThreadHost["threadStore"];
  readonly threadStore?: ThreadHost["threadStore"];
}

export function threadHost(host: AgentHost): ThreadHost {
  switch (host.kind) {
    case "thread":
      return host;
    case "session":
      return { kind: "thread", threadStore: threadStoreFromHost(host) };
    case "durable-background":
      return { kind: "thread", threadStore: threadStoreFromHost(host) };
    case "execution":
      return {
        kind: "thread",
        threadStore: threadStoreFromExecutionStore(host.store),
      };
    default:
      return assertNeverHost(host);
  }
}

/** @deprecated Use threadHost. */
export function sessionHost(host: AgentHost): SessionHost {
  const threadStore = threadHost(host).threadStore;
  return { kind: "session", sessionStore: threadStore, threadStore };
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
    sessionStore: threadStoreFromExecutionStore(host.store),
    threadStore: threadStoreFromExecutionStore(host.store),
    transaction: transactionForStore(host.store),
  };
}

function executionHostFromDurableBackgroundHost(
  host: DurableBackgroundHost
): ExecutionHost {
  const threadStore = threadStoreFromHost(host);
  return {
    kind: "execution",
    scheduler: host.backgroundScheduler,
    store: {
      checkpoints: host.checkpointStore,
      events: host.eventStore,
      notifications: host.notificationInbox,
      runs: host.runStore,
      sessions: threadStore,
      threads: threadStore,
      transaction: host.transaction,
    },
  };
}

function transactionForStore(store: ExecutionHost["store"]): Transaction {
  return (fn) => store.transaction(fn);
}

function threadStoreFromExecutionStore(
  store: ExecutionStorePorts
): ThreadHost["threadStore"] {
  return store.threads ?? store.sessions ?? assertMissingThreadStore();
}

function threadStoreFromHost(
  host: CompatibleThreadStoreHost
): ThreadHost["threadStore"] {
  return host.threadStore ?? host.sessionStore ?? assertMissingThreadStore();
}

function assertMissingThreadStore(): never {
  throw new Error("ExecutionStore requires a threads store");
}

function assertNeverHost(host: never): never {
  throw new Error(`Unsupported agent host: ${JSON.stringify(host)}`);
}
