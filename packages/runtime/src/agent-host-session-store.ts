import { sessionHost } from "./execution/host";
import type { AgentHost } from "./execution/types";
import { MemorySessionStore } from "./session/store/memory";
import type { SessionStore } from "./session/store/types";

export function sessionStoreForHost(host: AgentHost): SessionStore {
  return sessionHost(host).sessionStore ?? new MemorySessionStore();
}
