import type { DurableBackgroundHost, ThreadHost } from "./capabilities";
import type { AgentHost, ExecutionHost, ExecutionStorePorts } from "./types";
import { UnsupportedThreadInputInbox } from "./unsupported-thread-input-inbox";

type Transaction = ExecutionHost["store"]["transaction"];

export function threadHost(host: AgentHost): ThreadHost {
  switch (host.kind) {
    case "thread":
      return host;
    case "durable-background":
      return {
        attachmentStore: host.attachmentStore,
        kind: "thread",
        threadStore: host.threadStore,
      };
    case "execution":
      return {
        attachmentStore: host.attachmentStore,
        kind: "thread",
        threadStore: threadStoreFromExecutionStore(host.store),
      };
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

function durableBackgroundHostFromExecutionHost(
  host: ExecutionHost
): DurableBackgroundHost {
  return {
    attachmentStore: host.attachmentStore,
    backgroundScheduler: host.scheduler,
    checkpointStore: host.store.checkpoints,
    eventStore: host.store.events,
    kind: "durable-background",
    notificationInbox: host.store.notifications,
    threadStore: threadStoreFromExecutionStore(host.store),
    transaction: transactionForStore(host.store),
    turnStore: host.store.turns,
  };
}

function executionHostFromDurableBackgroundHost(
  host: DurableBackgroundHost
): ExecutionHost {
  const threadStore = host.threadStore;
  return {
    attachmentStore: host.attachmentStore,
    kind: "execution",
    scheduler: host.backgroundScheduler,
    store: {
      events: host.eventStore,
      inputs: new UnsupportedThreadInputInbox(),
      notifications: host.notificationInbox,
      checkpoints: host.checkpointStore,
      threads: threadStore,
      turns: host.turnStore,
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
  return store.threads ?? assertMissingThreadStore();
}

function assertMissingThreadStore(): never {
  throw new Error("ExecutionStore requires a threads store");
}

function assertNeverHost(host: never): never {
  throw new Error(`Unsupported agent host: ${JSON.stringify(host)}`);
}
