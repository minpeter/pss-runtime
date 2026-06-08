import { executionHost } from "./execution/host";
import type { AgentHost } from "./execution/types";
import { MemorySessionStore } from "./session/store/memory";
import type { SessionStore } from "./session/store/types";

export function sessionStoreForHost(host: AgentHost): SessionStore {
  if ("sessionStore" in host && host.sessionStore) {
    return host.sessionStore;
  }

  const hostExecution = executionHost(host);
  return hostExecution
    ? hostExecution.store.sessions
    : new MemorySessionStore();
}
