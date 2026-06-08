import type { AgentHost, ExecutionHost } from "./types";

export function executionHost(host: AgentHost): ExecutionHost | undefined {
  if (isExecutionHost(host)) {
    return host;
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
