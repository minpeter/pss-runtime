import type { AgentHost, ThreadStore } from "@minpeter/pss-runtime";

export function threadStoreForHost(host: AgentHost): ThreadStore {
  switch (host.kind) {
    case "durable-background":
      return host.threadStore;
    case "execution":
      return host.store.threads;
    case "thread":
      return host.threadStore;
    default:
      return assertNever(host);
  }
}

function assertNever(value: never): never {
  throw new AgentHostThreadStoreError(
    `Unexpected agent host variant: ${String(value)}`
  );
}

class AgentHostThreadStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentHostThreadStoreError";
  }
}
